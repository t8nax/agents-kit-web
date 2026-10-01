using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>
/// Начало переписки о трекере проекта: просьба и описание таким, каким его видит оператор на вкладке «Изменения»
/// (у нового трекера — пустое).
/// </summary>
public sealed record TrackerRewriteRequest(string? Base, string? Wish, TrackerDescription? Description = null);

/// <summary>Следующая реплика и описание, каким оно стало в окне к ней: оператор мог поправить поля руками.</summary>
public sealed record TrackerRewriteReply(string? Text, TrackerDescription? Description = null);

/// <summary>Сколько строк и разделов описания тронул ответ — строка «В изменениях: …» под ответом.</summary>
public sealed record TrackerChanged(int Lines, int Sections);

/// <summary>
/// Событие переписки о трекере, одной строкой NDJSON, — как у переписки о флоу: reply, step, note, rework, answer
/// (Proposal — описание целиком, до которого договорились, Changed — сколько тронул этот ответ; у ответа без правки
/// их нет), error, stopped.
/// </summary>
public sealed record TrackerRewriteEvent(
    string Type,
    string Text,
    long? DurationMs = null,
    string? Output = null,
    TrackerDescription? Proposal = null,
    TrackerChanged? Changed = null) : IAgentEvent;

/// <summary>
/// Правила формы описания трекера для агента — раздел «Трекер» справки кита о раскладке базы. Панель их не повторяет
/// своими словами: форму файла правят в ките, как и форму флоу (decisions/base-agent.md, B-27).
/// </summary>
public static class TrackerRules
{
    public static readonly string RulesFile = Path.Combine("reference", "base-layout.md");

    private const string Heading = "## Трекер";

    /// <summary>Раздел «Трекер» справки кита; null — кит не задан, файл не прочитан или раздела нет.</summary>
    public static string? Read(string? kitPath)
    {
        if (string.IsNullOrWhiteSpace(kitPath))
            return null;
        string[] lines;
        try
        {
            lines = File.ReadAllLines(Path.Combine(kitPath, RulesFile));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var start = Array.FindIndex(lines, line => line.TrimEnd() == Heading);
        if (start < 0)
            return null;
        // Раздел идёт до следующего «##»; «##» в примере за оградой ``` — его часть.
        var end = lines.Length;
        var fenced = false;
        for (var i = start + 1; i < lines.Length; i++)
        {
            if (lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal))
                fenced = !fenced;
            else if (!fenced && lines[i].StartsWith("## ", StringComparison.Ordinal))
            {
                end = i;
                break;
            }
        }
        var text = string.Join("\n", lines[start..end]).TrimEnd();
        return text.Length > Heading.Length ? text : null;
    }
}

/// <summary>
/// Переписка оператора с агентом об описании трекера одной базы — B-293: агент расспрашивает по правилам кита и
/// предлагает описание целиком, записывает его панель по «Принять правки» той же записью, что и ручную правку.
/// Устроена как переписка о флоу (B-242): память разговора — живой процесс агента, сам он только читает.
/// </summary>
public sealed class TrackerConversations(IAgentChat agent, AgentRequests requests)
{
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private Turn? _turn;

    /// <summary>Описание в окне к последней реплике: на него ложится правка агента, с ним поднимается новый агент.</summary>
    private TrackerDescription _screen = new();

    /// <summary>Описание, до которого договорились за переписку; null — агент ещё ничего не предлагал.</summary>
    private TrackerDescription? _proposal;

    public AgentRequestSummary Start(string basePath, string? copyPath, string rules, string wish, TrackerDescription description)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, copyPath, rules);
        var request = requests.Start(
            AgentRequests.Tracker,
            basePath,
            ProjectName.Of(basePath),
            wish,
            (rewriting, cancellationToken) => RunAsync(basePath, replies.Reader, turn, rewriting, cancellationToken),
            continues: true,
            reply: new TrackerRewriteEvent("reply", wish));

        turn.Request = request;
        lock (_gate)
        {
            _turn = turn;
            _screen = description;
            _proposal = null;
            if (!turn.Ended)
                Send(turn, wish, TrackerRewriteEndpoints.Input(wish, description));
        }
        return request.Summary;
    }

    public AskReplied Reply(string text, TrackerDescription? description)
    {
        if (requests.Of(AgentRequests.Tracker) is not { Continues: true } request)
            return AskReplied.NoConversation;
        if (!request.Finished)
            return AskReplied.Answering;

        Turn? ended;
        lock (_gate)
        {
            ended = _turn;
            // Поля окна — такие, какие они сейчас: принятое и поправленное руками. Непринятое предложение остаётся рядом
            // с ними и уходит агенту с репликой, как у исполнителя (ревью B-323): в поля его кладёт только «Принять правки».
            _screen = description ?? _screen;

            // Живой агент выбирается и реплика уходит в его очередь под той же блокировкой, которой его работа
            // отмечает свой конец (B-262): кончившемуся агенту она не достаётся, а поднимает нового.
            if (_turn?.Request == request && request.Working && !_turn.Ended)
            {
                request.Reply(new TrackerRewriteEvent("reply", text));
                Send(_turn, text, TrackerRewriteEndpoints.Input(text, _screen, _proposal, first: false));
                return AskReplied.Sent;
            }
        }

        lock (_gate)
        {
            if (_turn != ended || !request.Finished)
                return AskReplied.Answering;
            var turn = Restart(request);
            request.Reply(new TrackerRewriteEvent("reply", text));
            Send(turn, text, TrackerRewriteEndpoints.Input(text, _screen, _proposal));
        }
        return AskReplied.Sent;
    }

    /// <summary>«Отменить»: ответ обрывается вместе с процессом агента, переписка остаётся.</summary>
    public bool Stop()
    {
        if (requests.Of(AgentRequests.Tracker) is not { Continues: true } request || request.Finished)
            return false;
        lock (_gate)
        {
            if (_turn?.Request != request)
                return false;
            _turn.Stopped = true;
            _turn.Timeout.Cancel();
        }
        return true;
    }

    private Turn Restart(AgentRequest request)
    {
        var previous = _turn!;
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, previous.Copy, previous.Rules) { Request = request };
        _turn = turn;
        request.Write(new TrackerRewriteEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (rewriting, cancellationToken) => RunAsync(request.Base, replies.Reader, turn, rewriting, cancellationToken));
        return turn;
    }

    private static void Send(Turn turn, string text, string message)
    {
        turn.Said = text;
        turn.ReworkedMs = null;
        turn.Timeout.CancelAfter(Answer);
        turn.Replies.TryWrite(Message(message));
    }

    private string? End(Turn turn, ChannelReader<string> replies)
    {
        lock (_gate)
        {
            turn.Ended = true;
            return replies.TryRead(out _) ? turn.Said : null;
        }
    }

    private async Task RunAsync(
        string basePath, ChannelReader<string> replies, Turn turn, AgentRequest rewriting, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, turn.Timeout.Token);
        var stream = new ClaudeStream(basePath, turn.Copy);
        try
        {
            var exit = await agent.RunAsync(
                TrackerRewriteEndpoints.StartInfo(basePath, turn.Copy, ProjectName.Of(basePath), turn.Rules),
                replies,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        rewriting.Write(e.Type == "step" ? new TrackerRewriteEvent("step", e.Text) : Outcome(e, turn));
                    if (stream.Finished)
                    {
                        turn.Timeout.CancelAfter(turn.Reworking ? Answer : Timeout.InfiniteTimeSpan);
                        if (!turn.Reworking)
                            turn.Raised = false;
                        turn.Reworking = false;
                        stream = new ClaudeStream(basePath, turn.Copy);
                    }
                    return Task.CompletedTask;
                },
                linked.Token);
            if (End(turn, replies) is { } left && !turn.Raised)
            {
                // Реплику, которую кончившийся агент не прочёл, получает новый — с описанием целиком.
                lock (_gate)
                {
                    if (turn.Stopped)
                        rewriting.Write(new TrackerRewriteEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет"));
                    else if (_turn == turn)
                        Send(Restart(rewriting), left, TrackerRewriteEndpoints.Input(left, _screen, _proposal));
                }
                return;
            }
            if (!rewriting.Finished)
                rewriting.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            End(turn, replies);
            rewriting.Write(turn.Stopped
                ? new TrackerRewriteEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет")
                : new TrackerRewriteEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>
    /// Итог реплики: слова агента и описание, которое он предложил. Описание не в форме кита панель один раз на
    /// реплику сама возвращает агенту на доработку, как переписка о флоу (B-256); не вышло и со второго раза —
    /// ошибка со словами агента, а договорённое остаётся как было.
    /// </summary>
    private TrackerRewriteEvent Outcome(AskEvent answer, Turn turn)
    {
        if (answer.Type != "answer")
            return new TrackerRewriteEvent("error", answer.Text, Output: FlowRewriteEndpoints.Shorten(answer.Output));

        lock (_gate)
        {
            var taken = TrackerRewriteEndpoints.Take(answer.Text);
            if (taken.Error is { } error && turn.ReworkedMs is null)
            {
                turn.ReworkedMs = answer.DurationMs ?? 0;
                turn.Reworking = true;
                turn.Replies.TryWrite(Message(TrackerRewriteEndpoints.Rework(error)));
                return new TrackerRewriteEvent("rework", $"{error}. Панель вернула ответ {AgentRequests.AgentName} на доработку.");
            }
            if (taken.Error is { } again)
                return new TrackerRewriteEvent("error", again, Output: FlowRewriteEndpoints.Shorten(answer.Text));

            var duration = answer.DurationMs + turn.ReworkedMs ?? answer.DurationMs;
            if (taken.Description is not { } proposed)
                return new TrackerRewriteEvent("answer", taken.Said, duration, Proposal: _proposal);

            var (lines, sections) = TrackerDescriptions.Changed(_proposal ?? _screen, proposed);
            _proposal = proposed;
            return new TrackerRewriteEvent(
                "answer", taken.Said, duration, Proposal: proposed, Changed: new TrackerChanged(lines, sections));
        }
    }

    private static string Message(string text) => JsonSerializer.Serialize(
        new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        },
        AgentRequest.JsonOptions);

    private static TrackerRewriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new TrackerRewriteEvent("error", "Claude Code не запустился", Output: exit.Error);
        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new TrackerRewriteEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? FlowRewriteEndpoints.Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    private sealed class Turn(ChannelWriter<string> replies, string? copy, string rules)
    {
        public ChannelWriter<string> Replies { get; } = replies;

        public string? Copy { get; } = copy;

        public string Rules { get; } = rules;

        public CancellationTokenSource Timeout { get; } = new();

        public AgentRequest? Request { get; set; }

        public bool Stopped { get; set; }

        public long? ReworkedMs { get; set; }

        public bool Reworking { get; set; }

        public bool Ended { get; set; }

        public string? Said { get; set; }

        public bool Raised { get; set; } = true;
    }
}

public static class TrackerRewriteEndpoints
{
    /// <summary>Пометка блока с описанием в ответе агента.</summary>
    public const string Marker = "=== описание";

    private static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string>
    {
        ["tracker"] = "строка «трекер:»",
        ["server"] = "строка «сервер:»",
        ["project"] = "строка «проект:»",
        ["filter"] = "строка «фильтр:»",
        ["where"] = "слова раздела «Где задачи»",
        ["backlog"] = "раздел «Показ бэклога»",
        ["take"] = "раздел «Взятие задачи»",
        ["closed"] = "раздел «Задача закрыта»",
        ["move"] = "раздел «Вынос записи бэклога»",
    };

    /// <summary>Слова ответа и описание из блока «=== описание»; блока нет — Description null. Error — блок не в форме кита.</summary>
    public sealed record Taken(string Said, TrackerDescription? Description, string? Error);

    public static Taken Take(string answer)
    {
        var lines = answer.ReplaceLineEndings("\n").Split('\n');
        var at = Array.FindIndex(lines, l => l.Trim() == Marker);
        if (at < 0)
            return new Taken(answer.Trim(), null, null);

        var said = string.Join("\n", lines[..at]).Trim();
        var block = FlowRewriteEndpoints.Unfence(string.Join("\n", lines[(at + 1)..]));
        var description = TrackerDescriptions.Parse(block);
        var faults = TrackerDescriptions.Faults(description);
        return faults.Count == 0
            ? new Taken(said, description, null)
            : new Taken(said, null, "Описание не в форме кита: " + string.Join("; ",
                faults.Select(f => $"{Labels.GetValueOrDefault(f.Key, f.Key)} — {Lower(f.Value)}")));
    }

    public static string Rework(string error) => $"""
        Панель не приняла твой ответ: {error}.
        Верни ответ заново — описание целиком блоком «{Marker}»: заголовок, раздел «## Где задачи» со строками трекера,
        сервера и проекта (и строкой «фильтр:», если фильтр задан), пустой строкой и словами, и все остальные разделы,
        каждый непустой.
        """;

    public static void MapTrackerRewriteEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/trackers/rewrite", async (
            TrackerRewriteRequest request, BasesStore bases, TrackerConversations conversations,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            // Правила формы описания держит кит: своих слов о ней у панели нет, и без них агент не запускается.
            if (TrackerRules.Read(bases.Kit()) is not { } rules)
                return Results.UnprocessableEntity(new TrackerRewriteEvent(
                    "error",
                    $"Панель не прочитала у кита правила описания трекера ({TrackerRules.RulesFile}): путь к киту задаётся в «Настройках»"));

            // Агент читает код проекта — чем он собран и где лежит: работает в основной копии, а нет её — в базе.
            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            var copyPath = copies.FirstOrDefault(c => c.Main)?.Path;

            return Results.Ok(conversations.Start(
                basePath, copyPath, rules, request.Wish.Trim(), request.Description ?? new TrackerDescription()));
        });

        app.MapPost("/api/trackers/rewrite/reply", (TrackerRewriteReply reply, TrackerConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();
            return conversations.Reply(reply.Text.Trim(), reply.Description) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });

        app.MapPost("/api/trackers/rewrite/stop", (TrackerConversations conversations) =>
            conversations.Stop() ? Results.NoContent() : Results.NotFound());
    }

    /// <summary>
    /// Агент работает в копии проекта и только читает: описание пишет панель, и только по «Принять правки».
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string? copyPath, string project, string rules)
    {
        var place = copyPath is null
            ? "Текущий каталог — база знаний проекта."
            : $"Текущий каталог — рабочая копия проекта: по её коду видно, где живёт проект. База знаний проекта лежит в {basePath}.";
        var trackers = string.Join(", ", TrackerDescriptions.Known.Select(k => k.Name));
        var systemPrompt = $"""
            Ты с оператором веб-панели пишешь описание трекера проекта «{project}» — файл tracker.md в корне базы знаний
            agents-kit {basePath}: какой трекер у проекта, где в нём задачи и что с ними делать, когда их берут
            в работу, закрывают и заводят из записи бэклога. Это переписка: оператор просит и уточняет, ты отвечаешь.
            {place}
            Описание таким, каким его видит оператор в окне, приходит с каждой его репликой; оно важнее файла на диске.
            Пустое описание — трекер у проекта только заводится.
            Трекер — один из: {trackers}.
            У GitHub и YouTrack сразу за строкой «проект:» может стоять строка «фильтр:» — отбор задач, которые панель
            показывает оператору в «Бэклоге»: строка поиска самого трекера, которую панель дописывает к своему запросу
            «мои незакрытые задачи проекта», например «фильтр: State: {"{To Do}"}» у YouTrack или «фильтр: label:bug» у GitHub.
            Её правила кита не знают; пиши её, только когда оператор просит сузить список задач, одной строкой. Нет
            отбора — строки нет. У других трекеров её не бывает.
            Чего оператор не сказал — спроси, а не сочиняй: статусы, метки, колонки и поля трекера знает он.
            Не спрашивай больше трёх вопросов за раз и к каждому предложи свой вариант.
            Ключей, паролей, токенов и логинов в описании нет. Порядок работы оператора — вроде «комментарий в задачу
            после каждого этапа» — в описание не пишется: это его флоу, скажи ему об этом.
            Правку предлагай в конце ответа блоком: строка «{Marker}» и под ней файл tracker.md целиком — заголовок
            «# {project} — трекер» и все пять разделов, каждый непустой, даже если меняется одно слово.
            До блока — коротко, что ты сделал или о чём спрашиваешь. Не меняешь описание — блока нет.
            Файлы менять нельзя: описание запишет панель, и только с согласия оператора.
            {OperatorSpeech.Rule}
            Ниже правила кита об описании трекера; им описание и должно отвечать.

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
        AgentProcess.AddAutoMode(startInfo);
        if (copyPath is not null)
        {
            startInfo.ArgumentList.Add("--add-dir");
            startInfo.ArgumentList.Add(basePath);
        }
        return startInfo;
    }

    /// <summary>
    /// Реплика агенту: слова оператора, описание, каким оно стоит в окне трекера, и прошлое предложение агента, если оно
    /// с окном расходится: в поля оно ложится, только когда оператор его примет (ревью B-323, как у исполнителя — B-320).
    /// </summary>
    public static string Input(string text, TrackerDescription description, TrackerDescription? proposal = null, bool first = true)
    {
        var said = new StringBuilder().Append(first ? "Просьба оператора:\n" : "Оператор:\n").Append(text);
        said.Append("\n\nОписание в окне сейчас:\n");
        if (description == new TrackerDescription())
            said.Append("пусто — трекер у проекта заводится.");
        else
            said.Append(TrackerDescriptions.Serialize(description, "…").TrimEnd());
        if (proposal is not null && TrackerDescriptions.Changed(description, proposal) != (0, 0))
            said.Append("\n\nТвоё последнее предложение — в поля окна оно ложится, только когда оператор его примет, ")
                .Append("поэтому описание выше может быть без него. Правь его, если оператор не просит иного:\n")
                .Append(TrackerDescriptions.Serialize(proposal, "…").TrimEnd());
        return said.ToString();
    }

    private static string Lower(string text) => text.Length == 0 ? text : char.ToLowerInvariant(text[0]) + text[1..];
}
