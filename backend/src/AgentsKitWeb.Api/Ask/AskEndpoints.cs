using System.Diagnostics;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

public sealed record AskBase(string Base, string Project);

public sealed record AskRequest(string? Base, string? Question);

public static class AskEndpoints
{
    public const string Claude = "claude";

    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    // Раскладку базы агент иначе угадывает: название проекта, например, ищет в README.
    private const string SystemPrompt = """
        Ты отвечаешь оператору на один вопрос о проекте по его базе знаний agents-kit — это текущий каталог.
        Что где лежит: product.md — что за система, его заголовок — название проекта; boundaries.md — рамки
        и оглавление решений; decisions/*.md — решения по областям; flow.md — как ведут задачу; backlog.md —
        записи бэклога; work/*.md — память задач в работе.
        Только читай файлы, ничего не меняй. Отвечай по-русски, коротко и по делу, называя файлы, на которых
        стоит ответ.
        """;

    public static void MapAskEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ask/bases", (BasesStore bases) =>
            bases.List().Select(b => new AskBase(b, ProjectName.Of(b))).ToList());

        // Просьбу держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        app.MapPost("/api/ask", (AskRequest request, BasesStore bases, IAgentProcess agent, AgentRequests requests) =>
        {
            // Агент запускается только в базе из списка панели: путь запроса сверяется со списком.
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Question))
                return Results.BadRequest();

            var question = request.Question.Trim();
            var started = requests.Start(
                AgentRequests.Ask, basePath, ProjectName.Of(basePath), question,
                (asking, cancellationToken) => RunAsync(basePath, question, agent, asking, cancellationToken));
            return Results.Ok(started.Summary);
        });
    }

    private static async Task RunAsync(
        string basePath, string question, IAgentProcess agent, AgentRequest asking, CancellationToken cancellationToken)
    {
        var stream = new ClaudeStream(basePath);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        try
        {
            var exit = await agent.RunAsync(
                StartInfo(basePath),
                question,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        asking.Write(e);
                    return Task.CompletedTask;
                },
                timeout.Token);
            if (!stream.Finished)
                asking.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            asking.Write(new AskEvent("error", "Агент не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>
    /// Агент только читает: набор инструментов сужен до чтения, а не одобрен поверх остальных. Вопрос уходит
    /// в stdin, а не в аргументы: текст оператора не должен стать флагом или командой.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath)
    {
        var startInfo = AgentProcess.StartInfo(Claude, basePath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", SystemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        return startInfo;
    }

    private static AskEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new AskEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new AskEvent(
            "error",
            "Агент завершился без ответа",
            Output: output.Length > 0 ? output : $"код выхода {exit.ExitCode}");
    }

}
