using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Просьба переписать стадии флоу. Stages — стадии, добавленные оператором в контекст, такими, какими их видно
/// в разделе, с несохранёнными правками; пусто — агент пишет новую стадию. Titles — названия всех стадий раздела:
/// новое название с ними не совпадёт.
/// </summary>
public sealed record FlowRewriteRequest(
    string? Base,
    string? Wish,
    IReadOnlyList<FlowStage>? Stages = null,
    IReadOnlyList<string>? Titles = null);

/// <summary>Стадия из ответа агента. Of — название стадии контекста, которую она переписывает; null — новая стадия.</summary>
public sealed record RewrittenStage(string? Of, FlowStage Stage);

/// <summary>
/// Событие переписывания стадий, одной строкой NDJSON. Type: step — ход работы агента (Text);
/// rewritten — ответ разобран (Stages — только те, что агент вернул, DurationMs); error — стадии не переписаны
/// (Text — почему, Output — что вернул агент).
/// </summary>
public sealed record FlowRewriteEvent(
    string Type,
    string Text,
    IReadOnlyList<RewrittenStage>? Stages = null,
    long? DurationMs = null,
    string? Output = null) : IAgentEvent;

public static partial class FlowRewriteEndpoints
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    /// <summary>Сколько текста агента показывать оператором, когда стадии из него не вышли.</summary>
    private const int OutputLimit = 2000;

    public const string NewStage = "новая стадия";

    // Строка перед файлом стадии в ответе: «=== стадия «Ревью»» или «=== новая стадия».
    [GeneratedRegex(@"^===\s*(?<head>.*?)\s*$")]
    private static partial Regex BlockLine { get; }

    [GeneratedRegex(@"^стадия\s*«(?<title>[^»]*)»$")]
    private static partial Regex OfStage { get; }

    public static void MapFlowRewriteEndpoints(this IEndpointRouteBuilder app)
    {
        // Просьбу держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        // Стадии панель не пишет — только разбирает: на схему их кладёт оператор, а записывает «Сохранить».
        app.MapPost("/api/flow/rewrite", async (
            FlowRewriteRequest request, BasesStore bases, IAgentProcess agent, AgentRequests requests,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            // Агент читает код проекта: работает он в основной копии, а нет её — в самой базе.
            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            var copyPath = copies.FirstOrDefault(c => c.Main)?.Path;

            var wish = request.Wish.Trim();
            var context = request.Stages ?? [];
            var titles = request.Titles ?? [];
            var kit = bases.Kit();
            var started = requests.Start(
                AgentRequests.Flow, basePath, ProjectName.Of(basePath), wish,
                async (rewriting, token) =>
                    rewriting.Write(await RunAsync(basePath, copyPath, wish, context, titles, kit, agent, rewriting, token)));
            return Results.Ok(started.Summary);
        });
    }

    private static async Task<FlowRewriteEvent> RunAsync(
        string basePath,
        string? copyPath,
        string wish,
        IReadOnlyList<FlowStage> context,
        IReadOnlyList<string> titles,
        string? kit,
        IAgentProcess agent,
        AgentRequest rewriting,
        CancellationToken aborted)
    {
        // Правила формы стадии держит кит: своих слов о ней у панели нет.
        if (FlowRules.Read(kit) is not { } rules)
            return new FlowRewriteEvent(
                "error",
                $"Панель не прочитала у кита правила формы стадии ({FlowRules.RulesFile}): путь к киту задаётся в «Настройках»");

        var stream = new ClaudeStream(basePath, copyPath);
        AskEvent? result = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(
                StartInfo(basePath, copyPath, ProjectName.Of(basePath), rules),
                Input(wish, context, titles, PerformerList.OfProject(basePath)),
                line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            rewriting.Write(new FlowRewriteEvent("step", e.Text));
                        else
                            result = e;
                    }
                    return Task.CompletedTask;
                },
                timeout.Token);
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return new FlowRewriteEvent("error", $"{AgentRequests.AgentName} не закончил за пять минут и остановлен");
        }

        if (result is null)
            return Failure(exit, stream);
        if (result.Type == "error")
            return new FlowRewriteEvent("error", result.Text, Output: Shorten(result.Output));

        return Parsed(result, context, titles);
    }

    /// <summary>
    /// Разбирает ответ агента в стадии тем же чтением, каким панель читает файлы стадий с диска, и отказывает,
    /// если стадию кит не примет: на схему кладётся только то, что «Сохранить» потом запишет.
    /// </summary>
    public static FlowRewriteEvent Parsed(AskEvent answer, IReadOnlyList<FlowStage> context, IReadOnlyList<string> titles)
    {
        FlowRewriteEvent Reject(string text) => new("error", text, Output: Shorten(answer.Text));

        var blocks = Blocks(Unfence(answer.Text));
        if (blocks.Count == 0)
            return Reject($"{AgentRequests.AgentName} вернул не стадию: стадий в его ответе нет");

        var stages = new List<RewrittenStage>();
        foreach (var (head, text) in blocks)
        {
            string? of = null;
            if (OfStage.Match(head) is { Success: true } match)
            {
                of = context.FirstOrDefault(s => FlowFolder.Key(s.Title) == FlowFolder.Key(match.Groups["title"].Value))?.Title;
                if (of is null)
                    return Reject($"{AgentRequests.AgentName} вернул стадию «{match.Groups["title"].Value}», которой в просьбе не было");
            }
            else if (FlowFolder.Key(head) != NewStage)
                return Reject($"{AgentRequests.AgentName} вернул стадию без пометки, какую он переписал: «=== {head}»");

            var slug = of is null ? null : context.First(s => s.Title == of).Slug;
            var (stage, unread) = FlowFolder.ReadStage(text, slug ?? "");
            stage = stage with { Slug = slug };
            var name = stage.Title.Length > 0 ? $"«{stage.Title}»" : "без названия";
            if (unread.Count > 0)
                return Reject($"Стадия {name} вернулась не в форме кита: {unread[0]}");
            if (FlowFolder.StageProblem(stage) is { } problem)
                return Reject($"Стадия {name} вернулась не в форме кита: {Problem(problem)}");
            stages.Add(new RewrittenStage(of, stage));
        }

        // Название — адрес стадии во всех флоу: две стадии с одним названием кит не примет.
        var kept = titles.Where(t => !stages.Any(s => s.Of is not null && FlowFolder.Key(s.Of) == FlowFolder.Key(t)));
        var taken = new HashSet<string>(kept.Select(FlowFolder.Key));
        foreach (var rewritten in stages)
            if (!taken.Add(FlowFolder.Key(rewritten.Stage.Title)))
                return Reject($"Стадия «{rewritten.Stage.Title}» вернулась с названием, которое у проекта уже есть");

        return new FlowRewriteEvent("rewritten", answer.Text, stages, answer.DurationMs);
    }

    /// <summary>
    /// Агент работает в копии проекта и только читает: стадии он не пишет — их кладёт на схему оператор,
    /// а записывает «Сохранить». Базу он видит по её пути, стадии контекста приходят в stdin такими, как на экране.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string? copyPath, string project, string rules)
    {
        var place = copyPath is null
            ? "Текущий каталог — база знаний проекта."
            : $"Текущий каталог — рабочая копия проекта: читай её код, чтобы понять, чем проект сделан и чем проверяется работа. База знаний проекта лежит в {basePath}.";

        var systemPrompt = $"""
            Ты пишешь и переписываешь стадии флоу проекта «{project}» — файлы flow/stages/*.md базы знаний agents-kit —
            по просьбе оператора из веб-панели; спросить оператора нельзя.
            {place} В базе флоу проекта — flow/flow.md и стадии в flow/stages/ — и его решения в decisions/.
            Просьба придёт одним сообщением вместе со стадиями, которые оператор к ней добавил, названиями остальных
            стадий проекта и исполнителями проекта. Стадии из сообщения — такие, какими их видит оператор, — важнее
            файлов на диске.
            Исполнитель и помощники стадии — из исполнителей проекта или «оркестратор», «оператор»; других имён не ставь.
            Переписывать можно любую из добавленных стадий, а по просьбе — завести новую. Добавленных нет — напиши новую.
            Меняй только то, о чём просит оператор; название меняй, только если об этом просили.
            Ответом верни только стадии, которые изменил или завёл, и ничего больше: ни пояснений, ни разговора.
            Перед каждой стадией — строка «=== стадия «Название»» с прежним названием переписанной стадии
            или строка «=== {NewStage}», под ней — файл стадии целиком. Текст можно завернуть в ``` — панель ограду снимет.
            Файлы менять нельзя: стадии запишет панель, и только с согласия оператора.
            Ниже правила кита о форме стадии; им новый текст и должен отвечать.

            {rules}
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath ?? basePath);
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
        // Агент в копии читает и базу: она лежит вне текущего каталога.
        if (copyPath is not null)
        {
            startInfo.ArgumentList.Add("--add-dir");
            startInfo.ArgumentList.Add(basePath);
        }
        return startInfo;
    }

    /// <summary>Просьба, стадии контекста, остальные названия и исполнители проекта уходят агенту в stdin.</summary>
    public static string Input(
        string wish, IReadOnlyList<FlowStage> context, IReadOnlyList<string> titles, IReadOnlyList<Performer> performers)
    {
        var text = new StringBuilder().Append("Просьба оператора:\n").Append(wish);

        if (context.Count == 0)
            text.Append("\n\nСтадий к просьбе не добавлено: напиши новую стадию.");
        foreach (var stage in context)
            text.Append($"\n\nДобавленная стадия «{stage.Title}»:\n").Append(FlowFolder.SerializeStage(stage));

        var others = titles.Where(t => !context.Any(s => FlowFolder.Key(s.Title) == FlowFolder.Key(t))).ToList();
        if (others.Count > 0)
            text.Append("\n\nОстальные стадии проекта: ").Append(string.Join(", ", others.Select(t => $"«{t}»")));

        text.Append("\n\nИсполнители проекта:");
        if (performers.Count == 0)
            text.Append(" не заведены — исполнитель только «оркестратор» или «оператор».");
        foreach (var performer in performers)
            text.Append($"\n- {performer.Name}").Append(performer.Description is { Length: > 0 } d ? $" — {d}" : "");
        return text.ToString();
    }

    /// <summary>Ограда ```…``` вокруг ответа: агента просят вернуть голый текст, но ограду он ставит часто.</summary>
    public static string Unfence(string answer)
    {
        var text = answer.Trim();
        if (!text.StartsWith("```", StringComparison.Ordinal))
            return answer;

        var firstBreak = text.IndexOf('\n');
        var lastFence = text.LastIndexOf("```", StringComparison.Ordinal);
        return firstBreak < 0 || lastFence <= firstBreak ? answer : text[(firstBreak + 1)..lastFence];
    }

    // Ответ по строкам «=== …»: пометка и текст файла под ней. Текст до первой пометки — не стадия.
    private static List<(string Head, string Text)> Blocks(string answer)
    {
        var blocks = new List<(string Head, List<string> Lines)>();
        foreach (var line in answer.Replace("\r\n", "\n").Split('\n'))
        {
            if (BlockLine.Match(line) is { Success: true } block)
                blocks.Add((block.Groups["head"].Value, []));
            else if (blocks.Count > 0)
                blocks[^1].Lines.Add(line);
        }
        return blocks.Select(b => (b.Head, string.Join("\n", b.Lines))).ToList();
    }

    private static FlowRewriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new FlowRewriteEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new FlowRewriteEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    private static string? Shorten(string? output) =>
        output is { Length: > OutputLimit } long_ ? long_[..OutputLimit] + "…" : output;

    private static string Problem(string problem) => problem switch
    {
        "stage-empty-title" => "нет названия",
        "stage-empty-executor" => "не указан исполнитель",
        "stage-empty-output" => "не указан выход",
        "stage-bad-title" => "в названии скобки или кавычки",
        "helpers-not-orchestrator" => "помощники у стадии, которую делает не оркестратор",
        _ => "перевод строки в ключе стадии",
    };
}
