using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Начало переписки о флоу. Stages и Flows — этапы и сценарии раздела такими, какими их видит оператор:
/// агент получает флоу целиком, а что править, оператор говорит словами (B-242).
/// </summary>
public sealed record FlowRewriteRequest(
    string? Base,
    string? Wish,
    IReadOnlyList<FlowStage>? Stages = null,
    IReadOnlyList<NamedFlow>? Flows = null);

/// <summary>Следующая реплика переписки и флоу раздела, каким он стал к ней: оператор мог записать правки.</summary>
public sealed record FlowRewriteReply(
    string? Text,
    IReadOnlyList<FlowStage>? Stages = null,
    IReadOnlyList<NamedFlow>? Flows = null);

/// <summary>
/// Событие переписки о флоу, одной строкой NDJSON. Type: reply — реплика оператора; step — ход агента; note — слово
/// панели в переписке; answer — ответ агента (Text — слова без блоков правок, DurationMs, Proposal — все правки,
/// до которых договорились, Changed — сколько тронул этот ответ; у ответа без правок его нет); error — ход не удался
/// (Text — почему, Output — что вывел агент); stopped — ответ оборвал оператор.
/// </summary>
public sealed record FlowRewriteEvent(
    string Type,
    string Text,
    long? DurationMs = null,
    string? Output = null,
    FlowProposal? Proposal = null,
    FlowChanged? Changed = null) : IAgentEvent;

/// <summary>Чем кончилась попытка начать переписку.</summary>
public enum FlowRewriteStarted
{
    Started,
    NoKitRules,
}

/// <summary>
/// Переписка оператора с агентом о флоу одной базы — B-242: оператор просит поменять сценарии и этапы, агент
/// отвечает, переспрашивает и предлагает правки, а записывает их панель по «Принять правки». Память разговора —
/// живой процесс агента, как у вопроса по базе (B-79); сам он только читает.
/// </summary>
public sealed class FlowConversations(IAgentChat agent, AgentRequests requests)
{
    /// <summary>Сколько ждать ответа на одну реплику. Между репликами процесс стоит сколько угодно.</summary>
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private Turn? _turn;

    /// <summary>Флоу раздела к последней реплике: на него ложатся правки, с ним поднимается новый агент после срыва.</summary>
    private Screen? _screen;

    /// <summary>Правки, до которых договорились за переписку, — ещё не записанные.</summary>
    private FlowProposal _proposal = FlowProposal.Empty;

    public AgentRequestSummary Start(
        string basePath, string? copyPath, string rules, string wish, IReadOnlyList<FlowStage> stages, IReadOnlyList<NamedFlow> flows)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, copyPath, rules);
        var request = requests.Start(
            AgentRequests.Flow,
            basePath,
            ProjectName.Of(basePath),
            wish,
            (rewriting, cancellationToken) => RunAsync(basePath, replies.Reader, turn, rewriting, cancellationToken),
            continues: true);

        turn.Request = request;
        var screen = new Screen(stages, flows);
        lock (_gate)
        {
            _turn = turn;
            _screen = screen;
            _proposal = FlowProposal.Empty;
        }
        // Флоу целиком агент получает первой репликой: дальше разговор идёт о нём.
        Say(request, turn, wish, FlowRewriteEndpoints.Input(wish, screen.Stages, screen.Flows, Tasks(basePath, flows), PerformerList.OfProject(basePath)));
        return request.Summary;
    }

    public AskReplied Reply(string text, IReadOnlyList<FlowStage>? stages, IReadOnlyList<NamedFlow>? flows)
    {
        if (requests.Of(AgentRequests.Flow) is not { Continues: true } request)
            return AskReplied.NoConversation;
        if (!request.Finished)
            return AskReplied.Answering;

        Turn? turn;
        Screen screen;
        FlowProposal proposal;
        lock (_gate)
        {
            turn = _turn?.Request == request && request.Working ? _turn : null;
            screen = stages is null || flows is null ? _screen! : new Screen(stages, flows);
            _screen = screen;
            // Записанное оператором из правок уходит: дальше они ложатся на флоу, каким он стал.
            _proposal = proposal = FlowProposals.Rebase(screen.Stages, screen.Flows, _proposal);
        }

        var message = text;
        if (turn is null)
        {
            // Новый агент прежнего разговора не знает: флоу он получает заново — с правками, до которых договорились.
            turn = Restart(request);
            var (proposedStages, proposedFlows) = FlowProposals.Apply(screen.Stages, screen.Flows, proposal);
            message = FlowRewriteEndpoints.Input(
                text, proposedStages, proposedFlows, Tasks(request.Base, screen.Flows), PerformerList.OfProject(request.Base));
        }
        Say(request, turn, text, message);
        return AskReplied.Sent;
    }

    /// <summary>«Отменить»: нынешний ответ обрывается вместе с процессом агента, переписка остаётся — как у вопроса по базе.</summary>
    public bool Stop()
    {
        if (requests.Of(AgentRequests.Flow) is not { Continues: true } request || request.Finished)
            return false;

        Turn? turn;
        lock (_gate)
            turn = _turn?.Request == request ? _turn : null;
        if (turn is null)
            return false;

        turn.Stopped = true;
        turn.Timeout.Cancel();
        return true;
    }

    private Turn Restart(AgentRequest request)
    {
        Turn previous;
        lock (_gate)
            previous = _turn!;
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, previous.Copy, previous.Rules) { Request = request };
        lock (_gate)
            _turn = turn;

        request.Write(new FlowRewriteEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (rewriting, cancellationToken) => RunAsync(request.Base, replies.Reader, turn, rewriting, cancellationToken));
        return turn;
    }

    /// <summary>Реплика встаёт в переписку своими словами, а агенту уходит строкой stdin; пошёл отсчёт ответа.</summary>
    private static void Say(AgentRequest request, Turn turn, string text, string message)
    {
        request.Reply(new FlowRewriteEvent("reply", text));
        turn.Timeout.CancelAfter(Answer);
        turn.Replies.TryWrite(Message(message));
    }

    private async Task RunAsync(
        string basePath,
        ChannelReader<string> replies,
        Turn turn,
        AgentRequest rewriting,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, turn.Timeout.Token);
        var stream = new ClaudeStream(basePath, turn.Copy);
        try
        {
            var exit = await agent.RunAsync(
                FlowRewriteEndpoints.StartInfo(basePath, turn.Copy, ProjectName.Of(basePath), turn.Rules),
                replies,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        rewriting.Write(e.Type == "step" ? new FlowRewriteEvent("step", e.Text) : Outcome(e));
                    if (stream.Finished)
                    {
                        turn.Timeout.CancelAfter(Timeout.InfiniteTimeSpan);
                        stream = new ClaudeStream(basePath, turn.Copy);
                    }
                    return Task.CompletedTask;
                },
                linked.Token);
            if (!rewriting.Finished)
                rewriting.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            rewriting.Write(turn.Stopped
                ? new FlowRewriteEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет")
                : new FlowRewriteEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>
    /// Итог реплики: слова агента и его правки, наложенные на прежние. Правки, которые запись не примет, не копятся —
    /// оператор видит ошибку со словами агента, а договорённое остаётся как было.
    /// </summary>
    private FlowRewriteEvent Outcome(AskEvent answer)
    {
        if (answer.Type != "answer")
            return new FlowRewriteEvent("error", answer.Text, Output: FlowRewriteEndpoints.Shorten(answer.Output));

        lock (_gate)
        {
            var taken = FlowProposals.Take(answer.Text, _screen!.Stages, _screen.Flows, _proposal);
            if (taken.Error is { } error)
                return new FlowRewriteEvent("error", error, Output: FlowRewriteEndpoints.Shorten(answer.Text));
            _proposal = taken.Proposal;
            return new FlowRewriteEvent("answer", taken.Said, answer.DurationMs, Proposal: taken.Proposal, Changed: taken.Changed);
        }
    }

    private static List<FlowTask> Tasks(string basePath, IReadOnlyList<NamedFlow> flows)
    {
        try
        {
            return FlowEndpoints.Tasks(basePath, flows);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
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

    private static FlowRewriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new FlowRewriteEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new FlowRewriteEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? FlowRewriteEndpoints.Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    /// <summary>Флоу раздела, каким его видит оператор.</summary>
    private sealed record Screen(IReadOnlyList<FlowStage> Stages, IReadOnlyList<NamedFlow> Flows);

    /// <summary>Живой процесс разговора: кому уходят реплики, где он читает код и по каким правилам кита пишет.</summary>
    private sealed class Turn(ChannelWriter<string> replies, string? copy, string rules)
    {
        public ChannelWriter<string> Replies { get; } = replies;

        public string? Copy { get; } = copy;

        public string Rules { get; } = rules;

        public CancellationTokenSource Timeout { get; } = new();

        public AgentRequest? Request { get; set; }

        public bool Stopped { get; set; }
    }
}

public static class FlowRewriteEndpoints
{
    /// <summary>Сколько текста агента показывать оператору, когда ответ не разобран.</summary>
    private const int OutputLimit = 2000;

    public static void MapFlowRewriteEndpoints(this IEndpointRouteBuilder app)
    {
        // Переписку держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        // Флоу панель по ней не пишет: записывает «Принять правки» обычной записью раздела.
        app.MapPost("/api/flow/rewrite", async (
            FlowRewriteRequest request, BasesStore bases, FlowConversations conversations,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            // Правила формы флоу держит кит: своих слов о ней у панели нет, и без них агент не запускается.
            if (FlowRules.Read(bases.Kit()) is not { } rules)
                return Results.UnprocessableEntity(new FlowRewriteEvent(
                    "error",
                    $"Панель не прочитала у кита правила формы этапа ({FlowRules.RulesFile}): путь к киту задаётся в «Настройках»"));

            // Агент читает код проекта: работает он в основной копии, а нет её — в самой базе.
            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            var copyPath = copies.FirstOrDefault(c => c.Main)?.Path;

            return Results.Ok(conversations.Start(
                basePath, copyPath, rules, request.Wish.Trim(), request.Stages ?? [], request.Flows ?? []));
        });

        app.MapPost("/api/flow/rewrite/reply", (FlowRewriteReply reply, FlowConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();

            return conversations.Reply(reply.Text.Trim(), reply.Stages, reply.Flows) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });

        app.MapPost("/api/flow/rewrite/stop", (FlowConversations conversations) =>
            conversations.Stop() ? Results.NoContent() : Results.NotFound());
    }

    /// <summary>
    /// Агент работает в копии проекта и только читает: флоу он не пишет — правки записывает панель, и только
    /// по «Принять правки». Базу он видит по её пути, флоу раздела приходит ему в stdin таким, как на экране.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string? copyPath, string project, string rules)
    {
        var place = copyPath is null
            ? "Текущий каталог — база знаний проекта."
            : $"Текущий каталог — рабочая копия проекта: читай её код, чтобы понять, чем проект сделан и чем проверяется работа. База знаний проекта лежит в {basePath}.";

        var systemPrompt = $"""
            Ты с оператором веб-панели правишь флоу проекта «{project}» — сценарии flow/scenarios.md и этапы
            flow/stages/*.md базы знаний agents-kit. Это переписка: оператор просит и уточняет, ты отвечаешь.
            {place} В базе и решения проекта — decisions/.
            Флоу целиком придёт первым сообщением — таким, каким его видит оператор; оно важнее файлов на диске.
            Непонятно, чего хочет оператор, или просьба спорит с тем, что уже есть во флоу, — спроси или скажи об этом,
            а правок не предлагай. Правка делает соседний пункт лишним или спорящим — поправь и его, даже если о нём
            не просили: флоу после правки должен читаться связно. Название меняй, только если об этом просили.
            Исполнитель и помощники этапа — из исполнителей проекта или «оркестратор», «оператор»; других имён не ставь.
            Сценарии и этапы, занятые задачами в работе, панель не запишет: если просьба их касается, скажи об этом.
            Правки предлагай в конце ответа блоками; до первого блока — что ты сделал или о чём спрашиваешь, коротко.
            Блок — строка-пометка и под ней текст целиком:
            «=== этап «Название»» — этап с этим названием переписан, под пометкой файл этапа целиком;
            «=== новый этап» — новый этап, под пометкой его файл;
            «=== удалить этап «Название»» — этап удаляется, под пометкой пусто;
            «=== сценарий «Имя»» — сценарий с этим именем переписан, под пометкой его раздел «## Имя» из scenarios.md
            целиком: «когда», пункты по порядку и возвраты;
            «=== новый сценарий» — новый сценарий, под пометкой его раздел;
            «=== удалить сценарий «Имя»» — сценарий удаляется, под пометкой пусто.
            Название в пометке — нынешнее, с учётом правок, предложенных раньше в этой переписке. Пункт сценария
            ссылается на этап его названием; адрес ссылки для нового этапа — любой вида stages/<файл>.md.
            Удалённый этап убери и из сценариев, где он стоит. Предлагай только то, что меняешь этим ответом:
            прежние правки панель помнит сама. Файлы менять нельзя: правки запишет панель, и только с согласия оператора.
            Ниже правила кита о форме сценария и этапа; им правки и должны отвечать.

            {rules}
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath ?? basePath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--input-format", "stream-json",
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

    /// <summary>
    /// Первая реплика агенту: просьба, флоу целиком — сценарии в форме scenarios.md и каждый этап файлом, — занятое
    /// задачами и исполнители проекта.
    /// </summary>
    public static string Input(
        string wish,
        IReadOnlyList<FlowStage> stages,
        IReadOnlyList<NamedFlow> flows,
        IReadOnlyList<FlowTask> tasks,
        IReadOnlyList<Performer> performers)
    {
        var text = new StringBuilder().Append("Просьба оператора:\n").Append(wish);

        text.Append("\n\nСценарии (flow/scenarios.md):\n");
        if (flows.Count == 0)
            text.Append("сценариев пока нет.");
        else
        {
            var slugs = stages.ToDictionary(s => FlowFolder.Key(s.Title), s => s.Slug ?? FlowFolder.NewSlug(s.Title, []));
            // Пункт, чьего этапа на экране нет, агенту всё равно виден: адрес у него — по названию.
            foreach (var entry in flows.SelectMany(f => f.Entries))
                slugs.TryAdd(FlowFolder.Key(entry.Stage), FlowFolder.NewSlug(entry.Stage, []));
            text.Append(FlowFolder.SerializeList("", flows, slugs).TrimEnd());
        }

        text.Append("\n\nЭтапы (flow/stages/):");
        if (stages.Count == 0)
            text.Append(" этапов пока нет.");
        foreach (var stage in stages)
            text.Append($"\n\n=== {(stage.Slug is { } slug ? $"stages/{slug}.md" : "новый, ещё не записан")}\n")
                .Append(FlowFolder.SerializeStage(stage).TrimEnd());

        text.Append("\n\nЗадачи в работе:");
        if (tasks.Count == 0)
            text.Append(" нет — править можно всё.");
        foreach (var task in tasks)
            text.Append($"\n- {task.Task}: ").Append(task.Flow is { } flow
                ? $"идёт по сценарию «{flow}» — его и его этапы панель не запишет"
                : "сценарий не узнан — панель не запишет ни одного сценария и этапа");

        text.Append("\n\nИсполнители проекта:");
        if (performers.Count == 0)
            text.Append(" не заведены — исполнитель только «оркестратор» или «оператор».");
        foreach (var performer in performers)
            text.Append($"\n- {performer.Name}").Append(performer.Description is { Length: > 0 } d ? $" — {d}" : "");
        return text.ToString();
    }

    /// <summary>Ограда ```…``` вокруг текста: агента просят вернуть голый текст, но ограду он ставит часто.</summary>
    public static string Unfence(string answer)
    {
        var text = answer.Trim();
        if (!text.StartsWith("```", StringComparison.Ordinal))
            return answer;

        var firstBreak = text.IndexOf('\n');
        var lastFence = text.LastIndexOf("```", StringComparison.Ordinal);
        return firstBreak < 0 || lastFence <= firstBreak ? answer : text[(firstBreak + 1)..lastFence];
    }

    internal static string? Shorten(string? output) =>
        output is { Length: > OutputLimit } long_ ? long_[..OutputLimit] + "…" : output;
}
