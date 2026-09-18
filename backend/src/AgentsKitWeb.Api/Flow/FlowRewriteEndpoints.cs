using System.Diagnostics;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Flow;

public sealed record FlowRewriteRequest(string? Base, string? Wish);

/// <summary>
/// Событие переписывания флоу, одной строкой NDJSON. Type: step — ход работы агента (Text);
/// rewritten — переписанный флоу разобран (Steps, Version — отпечаток файла, с которого агент работал,
/// DurationMs); error — флоу не переписан (Text — почему, Output — что вернул агент, Problem — «changed»,
/// когда флоу базы разошёлся, Step — шаг, который вернулся не в форме кита).
/// </summary>
public sealed record FlowRewriteEvent(
    string Type,
    string Text,
    IReadOnlyList<FlowStep>? Steps = null,
    string? Version = null,
    long? DurationMs = null,
    string? Output = null,
    string? Problem = null,
    int? Step = null);

public static class FlowRewriteEndpoints
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    /// <summary>Сколько текста агента показывать оператором, когда флоу из него не вышел.</summary>
    private const int OutputLimit = 2000;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Флоу и просьба по-русски: без этого каждая буква уходит в поток escape-последовательностью.
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    public static void MapFlowRewriteEndpoints(this IEndpointRouteBuilder app)
    {
        // Ход идёт потоком NDJSON, как вопрос по базе и запись в бэклог; флоу панель не пишет — только разбирает.
        app.MapPost("/api/flow/rewrite", async (
            FlowRewriteRequest request, BasesStore bases, IAgentProcess agent, HttpContext http) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            var response = http.Response;
            response.ContentType = "application/x-ndjson; charset=utf-8";
            response.Headers.CacheControl = "no-cache";
            await response.StartAsync(http.RequestAborted);

            try
            {
                var outcome = await RunAsync(basePath, request.Wish.Trim(), bases.Kit(), agent, response, http.RequestAborted);
                await WriteAsync(response, outcome, CancellationToken.None);
            }
            catch (OperationCanceledException)
            {
                // Оператор закрыл окно или отменил просьбу: писать итог некому, процесс агента уже убит.
            }
            return Results.Empty;
        });
    }

    private static async Task<FlowRewriteEvent> RunAsync(
        string basePath, string wish, string? kit, IAgentProcess agent, HttpResponse response, CancellationToken aborted)
    {
        var file = Path.Combine(basePath, FlowFile.FileName);
        byte[] before;
        try
        {
            before = await File.ReadAllBytesAsync(file, aborted);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new FlowRewriteEvent("error", "В базе нет flow.md или он не прочитан");
        }

        var version = FlowFile.Fingerprint(before);
        // Правила формы флоу держит кит: своих слов о ней у панели нет.
        if (FlowRules.Read(kit) is not { } rules)
            return new FlowRewriteEvent(
                "error",
                $"Панель не прочитала у кита правила формы флоу ({FlowRules.LayoutFile}): путь к киту задаётся в «Настройках»");

        var stream = new ClaudeStream(basePath);
        AskEvent? result = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(
                StartInfo(basePath, rules),
                Input(wish, FlowFile.Decode(before).Text),
                async line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            await WriteAsync(response, new FlowRewriteEvent("step", e.Text), timeout.Token);
                        else
                            result = e;
                    }
                },
                timeout.Token);
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return new FlowRewriteEvent("error", "Агент не закончил за пять минут и остановлен");
        }

        if (result is null)
            return Failure(exit, stream);
        if (result.Type == "error")
            return new FlowRewriteEvent("error", result.Text, Output: Shorten(result.Output));

        return await Parsed(file, version, result, aborted);
    }

    /// <summary>
    /// Разбирает ответ агента в шаги и проверяет, что флоу базы не ушёл вперёд: агент переписывал тот текст,
    /// который панель ему подала, и правка поверх чужой стёрла бы её молча.
    /// </summary>
    private static async Task<FlowRewriteEvent> Parsed(
        string file, string version, AskEvent answer, CancellationToken cancellationToken)
    {
        var document = FlowFile.Parse(Unfence(answer.Text));
        if (document.Steps.Count == 0)
            return new FlowRewriteEvent("error", "Агент вернул не флоу: шагов в его ответе нет", Output: Shorten(answer.Text));
        if (FlowFile.Validate(document.Steps) is { } rejection)
            return new FlowRewriteEvent(
                "error",
                $"Шаг {rejection.Step} вернулся не в форме кита: {Problem(rejection.Problem)}",
                Output: Shorten(answer.Text),
                Step: rejection.Step);

        try
        {
            if (FlowFile.Fingerprint(await File.ReadAllBytesAsync(file, cancellationToken)) != version)
                return new FlowRewriteEvent(
                    "error", "Флоу базы изменился, пока агент его переписывал", Problem: "changed");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new FlowRewriteEvent("error", "Флоу базы не перечитан после ответа агента");
        }

        return new FlowRewriteEvent("rewritten", answer.Text, document.Steps, version, answer.DurationMs);
    }

    /// <summary>
    /// Агент только читает базу: флоу он не пишет и не коммитит — это делает панель, когда оператор
    /// подтвердит правку. Текущий флоу и просьба уходят в stdin: агент переписывает ровно тот текст,
    /// который панель ему подала, а не тот, что лежит на диске к его приходу.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string rules)
    {
        var systemPrompt = $"""
            Ты переписываешь флоу проекта — файл {FlowFile.FileName} базы знаний agents-kit, это текущий каталог, —
            по просьбе оператора из веб-панели; спросить оператора нельзя.
            Текущий флоу и просьба придут одним сообщением. Ответом верни новый {FlowFile.FileName} целиком
            и ничего больше: ни пояснений, ни разговора. Текст можно завернуть в ``` — панель ограду снимет.
            Меняй только то, о чём просит оператор: остальные шаги, их ключи, описания и шапку файла оставь
            слово в слово. Номера шагов расставит панель.
            Файлы базы читать можно, чтобы понять проект; менять их нельзя — флоу запишет панель.
            Ниже правила кита о форме флоу; им новый текст и должен отвечать.

            {rules}
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, basePath);
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

    public static string Input(string wish, string flow) => $"""
        Просьба оператора:
        {wish}

        Текущий {FlowFile.FileName}:
        {flow}
        """;

    /// <summary>Ограда ```…``` вокруг файла: агента просят вернуть голый текст, но ограду он ставит часто.</summary>
    public static string Unfence(string answer)
    {
        var text = answer.Trim();
        if (!text.StartsWith("```", StringComparison.Ordinal))
            return answer;

        var firstBreak = text.IndexOf('\n');
        var lastFence = text.LastIndexOf("```", StringComparison.Ordinal);
        return firstBreak < 0 || lastFence <= firstBreak ? answer : text[(firstBreak + 1)..lastFence];
    }

    private static FlowRewriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new FlowRewriteEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new FlowRewriteEvent(
            "error",
            "Агент завершился без ответа",
            Output: output.Length > 0 ? Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    private static string? Shorten(string? output) =>
        output is { Length: > OutputLimit } long_ ? long_[..OutputLimit] + "…" : output;

    private static string Problem(FlowProblem problem) => problem switch
    {
        FlowProblem.EmptyTitle => "нет названия",
        FlowProblem.EmptyExecutor => "не указан исполнитель",
        FlowProblem.EmptyOutput => "не указан выход",
        _ => "перевод строки в ключе шага",
    };

    private static async Task WriteAsync(HttpResponse response, FlowRewriteEvent e, CancellationToken cancellationToken)
    {
        await response.WriteAsync(JsonSerializer.Serialize(e, JsonOptions) + "\n", cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }
}
