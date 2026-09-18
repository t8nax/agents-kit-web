using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

public sealed record AskBase(string Base, string Project);

public sealed record AskRequest(string? Base, string? Question);

public sealed record AskReply(string? Text);

/// <summary>Чем кончилась попытка отправить реплику в разговор.</summary>
public enum AskReplied
{
    Sent,
    NoConversation,
    Answering,
}

/// <summary>
/// Разговор оператора с агентом по одной базе. Переписку держит просьба панели, память разговора — живой
/// процесс агента: реплики уходят ему в stdin по одной, и сессия на диск не ложится — решения оператора
/// на B-79. Разом идёт один разговор: новый останавливает прежний.
/// </summary>
public sealed class AskConversations(IAgentChat agent, AgentRequests requests)
{
    /// <summary>Сколько ждать ответа на одну реплику. Между репликами процесс стоит сколько угодно.</summary>
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private Turn? _turn;

    public AgentRequestSummary Start(string basePath, string question)
    {
        var replies = Channel.CreateUnbounded<string>();
        var timeout = new CancellationTokenSource();
        var request = requests.Start(
            AgentRequests.Ask,
            basePath,
            ProjectName.Of(basePath),
            question,
            (asking, cancellationToken) => RunAsync(basePath, replies.Reader, timeout, asking, cancellationToken),
            continues: true);

        var turn = new Turn(request.Id, replies.Writer, timeout);
        lock (_gate)
            _turn = turn;
        Say(request, turn, question);
        return request.Summary;
    }

    public AskReplied Reply(string text)
    {
        if (requests.Of(AgentRequests.Ask) is not { Continues: true } request)
            return AskReplied.NoConversation;
        // Пока идёт ответ, следующая реплика не отправляется: окно её и не даёт набрать.
        if (!request.Finished)
            return AskReplied.Answering;

        Turn? turn;
        lock (_gate)
            turn = _turn?.Id == request.Id && request.Working ? _turn : null;

        turn ??= Restart(request);
        Say(request, turn, text);
        return AskReplied.Sent;
    }

    /// <summary>
    /// Процесс прежнего разговора кончился — сорвался или остановлен. Переписка остаётся на экране, новый
    /// процесс поднимается на следующей реплике, и панель честно говорит, что прошлого он не помнит.
    /// </summary>
    private Turn Restart(AgentRequest request)
    {
        var replies = Channel.CreateUnbounded<string>();
        var timeout = new CancellationTokenSource();
        var turn = new Turn(request.Id, replies.Writer, timeout);
        lock (_gate)
            _turn = turn;

        request.Write(new AskEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (asking, cancellationToken) => RunAsync(request.Base, replies.Reader, timeout, asking, cancellationToken));
        return turn;
    }

    /// <summary>Реплика встаёт в переписку событием и уходит агенту строкой stdin; пошёл отсчёт ответа.</summary>
    private static void Say(AgentRequest request, Turn turn, string text)
    {
        request.Reply(new AskEvent("reply", text));
        turn.Timeout.CancelAfter(Answer);
        turn.Replies.TryWrite(Message(text));
    }

    private async Task RunAsync(
        string basePath,
        ChannelReader<string> replies,
        CancellationTokenSource timeout,
        AgentRequest asking,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        var stream = new ClaudeStream(basePath);
        try
        {
            var exit = await agent.RunAsync(
                StartInfo(basePath),
                replies,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        asking.Write(e);
                    if (stream.Finished)
                    {
                        // Реплика отвечена: следующей ждём сколько угодно, а прочитанные файлы считаются заново.
                        timeout.CancelAfter(Timeout.InfiniteTimeSpan);
                        stream = new ClaudeStream(basePath);
                    }
                    return Task.CompletedTask;
                },
                linked.Token);
            // Процесс кончился на неотвеченной реплике — это сбой; кончился между репликами — просто сбой процесса,
            // и о нём скажет следующая реплика, подняв новый.
            if (!asking.Finished)
                asking.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            asking.Write(new AskEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>Реплика оператора в потоке stream-json: агент читает их построчно, по одной на ответ.</summary>
    private static string Message(string text) => JsonSerializer.Serialize(
        new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        },
        AgentRequest.JsonOptions);

    /// <summary>
    /// Агент только читает: набор инструментов сужен до чтения, а не одобрен поверх остальных. Реплики уходят
    /// в stdin, а не в аргументы: текст оператора не должен стать флагом или командой.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath)
    {
        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, basePath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--input-format", "stream-json",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", AskEndpoints.SystemPrompt,
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
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? output : $"код выхода {exit.ExitCode}");
    }

    /// <summary>Живой процесс разговора: кому уходят реплики и сколько ждать ответа на нынешнюю.</summary>
    private sealed record Turn(string Id, ChannelWriter<string> Replies, CancellationTokenSource Timeout);
}

public static class AskEndpoints
{
    public const string Claude = "claude";

    // Раскладку базы агент иначе угадывает: название проекта, например, ищет в README.
    internal const string SystemPrompt = """
        Ты разговариваешь с оператором о проекте по его базе знаний agents-kit — это текущий каталог.
        Что где лежит: product.md — что за система, его заголовок — название проекта; boundaries.md — рамки
        и оглавление решений; decisions/*.md — решения по областям; flow.md — как ведут задачу; backlog.md —
        записи бэклога; work/*.md — память задач в работе.
        Только читай файлы, ничего не меняй. Отвечай по-русски, коротко и по делу, называя файлы, на которых
        стоит ответ. Оператор переспрашивает и уточняет: помни, о чём шёл разговор.
        """;

    public static void MapAskEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ask/bases", (BasesStore bases) =>
            bases.List().Select(b => new AskBase(b, ProjectName.Of(b))).ToList());

        // Разговор держит панель: POST его заводит и отдаёт сводку, а переписку окно читает потоком просьбы.
        app.MapPost("/api/ask", (AskRequest request, BasesStore bases, AskConversations conversations) =>
        {
            // Агент запускается только в базе из списка панели: путь запроса сверяется со списком.
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Question))
                return Results.BadRequest();

            return Results.Ok(conversations.Start(basePath, request.Question.Trim()));
        });

        // Следующая реплика идёт в тот же разговор: база и агент у него свои, менять их не с чего.
        app.MapPost("/api/ask/reply", (AskReply reply, AskConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();

            return conversations.Reply(reply.Text.Trim()) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });
    }
}
