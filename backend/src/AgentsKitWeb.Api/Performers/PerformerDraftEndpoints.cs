using System.Diagnostics;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Поля исполнителя, какими их видит окно. При правке они уходят агенту: он переписывает заведённого,
/// а не сочиняет нового.
/// </summary>
public sealed record PerformerDraftFields(
    string? Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt);

/// <summary>Copy — копия, в которой агент работает: её код он и читает. Current задан — исполнителя правят.</summary>
public sealed record PerformerDraftRequest(string? Base, string? Copy, string? Wish, PerformerDraftFields? Current);

/// <summary>
/// Событие просьбы об исполнителе, одной строкой NDJSON. Type: step — ход работы агента (Text);
/// drafted — поля разобраны (Fields, DurationMs); error — полей нет (Text — почему, Output — что вернул агент).
/// </summary>
public sealed record PerformerDraftEvent(
    string Type,
    string Text,
    PerformerDraftFields? Fields = null,
    long? DurationMs = null,
    string? Output = null) : IAgentEvent;

/// <summary>
/// Чудо-Юдо придумывает исполнителя по описанию оператора. Агент только читает: он возвращает файл
/// субагента текстом, а разбирает его и пишет — панель, по кнопке «Сохранить» окна исполнителя.
/// </summary>
public static class PerformerDraftEndpoints
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    /// <summary>Сколько текста агента показывать оператору, когда исполнитель из ответа не вышел.</summary>
    private const int OutputLimit = 2000;

    public static void MapPerformerDraftEndpoints(this IEndpointRouteBuilder app)
    {
        // Просьбу держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        app.MapPost("/api/performers/draft", async (
            PerformerDraftRequest request,
            BasesStore bases,
            IAgentProcess agent,
            AgentRequests requests,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null
                ? null
                : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            // Агент работает в той копии, что выбрана в окне: исполнитель ляжет именно в неё.
            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            var copy = request.Copy is null
                ? null
                : copies.FirstOrDefault(c => string.Equals(
                    WorkspaceCollector.Normalize(c.Path), WorkspaceCollector.Normalize(request.Copy),
                    StringComparison.OrdinalIgnoreCase));
            if (copy is null)
                return Results.NotFound();

            var wish = request.Wish.Trim();
            var current = request.Current;
            var started = requests.Start(
                AgentRequests.Performer, basePath, ProjectName.Of(basePath), wish,
                async (drafting, token) =>
                    drafting.Write(await RunAsync(basePath, copy.Path, wish, current, agent, drafting, token)));
            return Results.Ok(started.Summary);
        });
    }

    private static async Task<PerformerDraftEvent> RunAsync(
        string basePath,
        string copyPath,
        string wish,
        PerformerDraftFields? current,
        IAgentProcess agent,
        AgentRequest drafting,
        CancellationToken aborted)
    {
        var stream = new ClaudeStream(basePath, copyPath);
        AskEvent? result = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(
                StartInfo(basePath, copyPath, ProjectName.Of(basePath), current is not null),
                Input(wish, await FlowAsync(basePath, aborted), current),
                line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            drafting.Write(new PerformerDraftEvent("step", e.Text));
                        else
                            result = e;
                    }
                    return Task.CompletedTask;
                },
                timeout.Token);
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return new PerformerDraftEvent("error", $"{AgentRequests.AgentName} не закончил за пять минут и остановлен");
        }

        if (result is null)
            return Failure(exit, stream);
        if (result.Type == "error")
            return new PerformerDraftEvent("error", result.Text, Output: Shorten(result.Output));

        return Parsed(result);
    }

    /// <summary>Разбирает ответ агента тем же разбором, каким панель читает файлы исполнителей с диска.</summary>
    private static PerformerDraftEvent Parsed(AskEvent answer)
    {
        var fields = PerformerFile.Parse(FlowRewriteEndpoints.Unfence(answer.Text));
        if (fields.Prompt.Length == 0)
            return new PerformerDraftEvent(
                "error",
                $"{AgentRequests.AgentName} вернул не исполнителя: задания в его ответе нет",
                Output: Shorten(answer.Text));
        if (!PerformerFile.ValidName(fields.Name))
            return new PerformerDraftEvent(
                "error",
                fields.Name is null
                    ? $"{AgentRequests.AgentName} вернул исполнителя без имени"
                    : $"{AgentRequests.AgentName} вернул имя, которым субагента не зовут: {fields.Name}",
                Output: Shorten(answer.Text));

        return new PerformerDraftEvent(
            "drafted",
            answer.Text,
            new PerformerDraftFields(fields.Name, fields.Description, fields.Model, fields.Tools, fields.Prompt),
            answer.DurationMs);
    }

    /// <summary>
    /// Флоу базы уходит агенту текстом: по нему видно, какие у проекта шаги и кто их сейчас делает.
    /// Флоу нет — просьба всё равно идёт: исполнителя заводят и до того, как проект написал флоу.
    /// </summary>
    private static async Task<string?> FlowAsync(string basePath, CancellationToken cancellationToken)
    {
        try
        {
            var file = Path.Combine(basePath, FlowFile.FileName);
            return File.Exists(file) ? await File.ReadAllTextAsync(file, cancellationToken) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Агент работает в копии проекта и только читает: файл исполнителя пишет панель. Базу он видит по
    /// её пути — флоу приходит текстом, а остальное знание он дочитывает сам.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string copyPath, string project, bool editing)
    {
        var task = editing
            ? "Оператор правит заведённого исполнителя: его нынешний файл придёт там же. Меняй только то, о чём просит оператор, остальное оставь слово в слово."
            : "Посмотри, кто уже заведён в .claude/agents копии, и не повторяй ни их имён, ни их работы.";

        var systemPrompt = $"""
            Ты придумываешь исполнителя — субагента Claude Code — для проекта «{project}» по просьбе оператора
            из веб-панели; спросить оператора нельзя.
            Текущий каталог — рабочая копия проекта: читай её код, чтобы понять, чем проект сделан и чем
            проверяется работа. База знаний проекта лежит в {basePath}: там флоу проекта и его решения.
            Просьба оператора придёт одним сообщением вместе с флоу базы.
            {task}
            Ответом верни файл субагента целиком и ничего больше: ни пояснений, ни разговора. Текст можно
            завернуть в ``` — панель ограду снимет.
            Файл устроен так: шапка между строками «---» с ключами name, description, tools, model, под ней —
            задание исполнителя.
            name — строчные латинские буквы, цифры и дефис: этим именем зовёт исполнителя шаг флоу.
            description — одна фраза о том, когда его звать.
            tools — инструменты через запятую, как их пишет Claude Code; нужны все инструменты сессии —
            ключ не писать вовсе.
            model — opus, sonnet или haiku; годится модель позвавшей сессии — ключ не писать вовсе.
            Задание пиши тому, кто будет работать: что он читает, что делает и что возвращает.
            Файлы менять нельзя: исполнителя запишет панель, и только с согласия оператора.
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", systemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        return startInfo;
    }

    /// <summary>Просьба, флоу базы и — когда исполнителя правят — его нынешний файл уходят агенту в stdin.</summary>
    public static string Input(string wish, string? flow, PerformerDraftFields? current)
    {
        var text = new System.Text.StringBuilder()
            .Append("Просьба оператора:\n")
            .Append(wish);
        if (flow is not null)
            text.Append("\n\nФлоу проекта, ").Append(FlowFile.FileName).Append(" базы:\n").Append(flow);
        if (current is not null)
            text.Append("\n\nНынешний исполнитель:\n").Append(PerformerFile.Serialize(
                new PerformerFields(current.Name, current.Description, current.Model, current.Tools, current.Prompt)));
        return text.ToString();
    }

    private static PerformerDraftEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new PerformerDraftEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new PerformerDraftEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    private static string? Shorten(string? output) =>
        output is { Length: > OutputLimit } long_ ? long_[..OutputLimit] + "…" : output;
}
