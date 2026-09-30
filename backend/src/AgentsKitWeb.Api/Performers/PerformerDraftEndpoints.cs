using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Поля исполнителя, какими их видит окно. Они уходят агенту с каждой репликой: он правит то, что стоит в окне,
/// а не сочиняет исполнителя заново.
/// </summary>
public sealed record PerformerDraftFields(
    string? Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt);

/// <summary>
/// Начало переписки об исполнителе. Копии в запросе нет: агент работает в основной копии проекта — там же, куда ляжет
/// файл. Current — поля окна исполнителя сейчас (у нового бывают пустыми), Subject — имя заведённого, которого
/// переписывают; null — исполнителя заводят.
/// </summary>
public sealed record PerformerDraftRequest(string? Base, string? Wish, PerformerDraftFields? Current = null, string? Subject = null);

/// <summary>Следующая реплика и поля окна исполнителя к ней: оператор мог поправить их руками.</summary>
public sealed record PerformerDraftReply(string? Text, PerformerDraftFields? Current = null);

/// <summary>
/// Событие переписки об исполнителе, одной строкой NDJSON, — как у переписки о трекере: reply, step, note, rework,
/// answer (Proposal — исполнитель целиком, до которого договорились, Changed — какие поля тронул этот ответ: name,
/// description, model, tools, prompt; у ответа без исполнителя их нет), error, stopped.
/// </summary>
public sealed record PerformerDraftEvent(
    string Type,
    string Text,
    long? DurationMs = null,
    string? Output = null,
    PerformerDraftFields? Proposal = null,
    IReadOnlyList<string>? Changed = null) : IAgentEvent;

/// <summary>
/// Переписка оператора с агентом об исполнителе — B-320: агент расспрашивает и предлагает файл субагента целиком,
/// в поля окна его кладёт оператор по «Принять правки», а в базу — «Сохранить» окна исполнителя. Устроена как
/// переписка о трекере (B-293): память разговора — живой процесс агента, сам он только читает.
/// </summary>
public sealed class PerformerConversations(IAgentChat agent, AgentRequests requests)
{
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private Turn? _turn;

    /// <summary>Поля окна к последней реплике: с ними сверяется правка агента, с ними поднимается новый агент.</summary>
    private PerformerDraftFields? _screen;

    /// <summary>Исполнитель, до которого договорились за переписку; null — агент ещё ничего не предлагал.</summary>
    private PerformerDraftFields? _proposal;

    public AgentRequestSummary Start(
        string basePath, string copyPath, string? flow, string wish, PerformerDraftFields? current, string? subject)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, copyPath, flow, subject is not null);
        // Переписка помнит, кого переписывает: её подхватывает окно правки этого исполнителя, а не окно нового (B-80).
        var request = requests.Start(
            AgentRequests.Performer,
            basePath,
            ProjectName.Of(basePath),
            wish,
            (drafting, cancellationToken) => RunAsync(basePath, replies.Reader, turn, drafting, cancellationToken),
            continues: true,
            subject: subject,
            reply: new PerformerDraftEvent("reply", wish));

        turn.Request = request;
        lock (_gate)
        {
            _turn = turn;
            _screen = current;
            _proposal = null;
            if (!turn.Ended)
                Send(turn, wish, PerformerDraftEndpoints.Input(wish, flow, current, turn.Editing));
        }
        return request.Summary;
    }

    public AskReplied Reply(string text, PerformerDraftFields? current)
    {
        if (requests.Of(AgentRequests.Performer) is not { Continues: true } request)
            return AskReplied.NoConversation;
        if (!request.Finished)
            return AskReplied.Answering;

        Turn? ended;
        lock (_gate)
        {
            ended = _turn;
            // Правкой считается то, что в окне сейчас: принятое и поправленное руками ложится поверх предложенного.
            _screen = current ?? _screen;
            _proposal = null;

            // Живой агент выбирается и реплика уходит в его очередь под той же блокировкой, которой его работа
            // отмечает свой конец (B-262): кончившемуся агенту она не достаётся, а поднимает нового.
            if (_turn?.Request == request && request.Working && !_turn.Ended)
            {
                request.Reply(new PerformerDraftEvent("reply", text));
                Send(_turn, text, PerformerDraftEndpoints.Input(text, null, _screen, _turn.Editing, first: false));
                return AskReplied.Sent;
            }
        }

        lock (_gate)
        {
            if (_turn != ended || !request.Finished)
                return AskReplied.Answering;
            var turn = Restart(request);
            request.Reply(new PerformerDraftEvent("reply", text));
            Send(turn, text, PerformerDraftEndpoints.Input(text, turn.Flow, _screen, turn.Editing));
        }
        return AskReplied.Sent;
    }

    /// <summary>«Отменить»: ответ обрывается вместе с процессом агента, переписка остаётся.</summary>
    public bool Stop()
    {
        if (requests.Of(AgentRequests.Performer) is not { Continues: true } request || request.Finished)
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
        var turn = new Turn(replies.Writer, previous.Copy, previous.Flow, previous.Editing) { Request = request };
        _turn = turn;
        request.Write(new PerformerDraftEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (drafting, cancellationToken) => RunAsync(request.Base, replies.Reader, turn, drafting, cancellationToken));
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
        string basePath, ChannelReader<string> replies, Turn turn, AgentRequest drafting, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, turn.Timeout.Token);
        var stream = new ClaudeStream(basePath, turn.Copy);
        try
        {
            var exit = await agent.RunAsync(
                PerformerDraftEndpoints.StartInfo(basePath, turn.Copy, ProjectName.Of(basePath), turn.Editing),
                replies,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        drafting.Write(e.Type == "step" ? new PerformerDraftEvent("step", e.Text) : Outcome(e, turn));
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
                // Реплику, которую кончившийся агент не прочёл, получает новый — с флоу и полями целиком.
                lock (_gate)
                {
                    if (turn.Stopped)
                        drafting.Write(new PerformerDraftEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет"));
                    else if (_turn == turn)
                        Send(Restart(drafting), left, PerformerDraftEndpoints.Input(left, turn.Flow, _proposal ?? _screen, turn.Editing));
                }
                return;
            }
            if (!drafting.Finished)
                drafting.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            End(turn, replies);
            drafting.Write(turn.Stopped
                ? new PerformerDraftEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет")
                : new PerformerDraftEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>
    /// Итог реплики: слова агента и исполнитель, которого он предложил. Исполнителя, которого панель не разберёт, она
    /// один раз на реплику сама возвращает агенту на доработку, как переписка о трекере; не вышло и со второго раза —
    /// ошибка со словами агента, а договорённое остаётся как было.
    /// </summary>
    private PerformerDraftEvent Outcome(AskEvent answer, Turn turn)
    {
        if (answer.Type != "answer")
            return new PerformerDraftEvent("error", answer.Text, Output: FlowRewriteEndpoints.Shorten(answer.Output));

        lock (_gate)
        {
            var taken = PerformerDraftEndpoints.Take(answer.Text);
            if (taken.Error is { } error && turn.ReworkedMs is null)
            {
                turn.ReworkedMs = answer.DurationMs ?? 0;
                turn.Reworking = true;
                turn.Replies.TryWrite(Message(PerformerDraftEndpoints.Rework(error)));
                return new PerformerDraftEvent("rework", $"{error}. Панель вернула ответ {AgentRequests.AgentName} на доработку.");
            }
            if (taken.Error is { } again)
                return new PerformerDraftEvent("error", again, Output: FlowRewriteEndpoints.Shorten(answer.Text));

            var duration = answer.DurationMs + turn.ReworkedMs ?? answer.DurationMs;
            if (taken.Performer is not { } proposed)
                return new PerformerDraftEvent("answer", taken.Said, duration, Proposal: _proposal);

            var changed = PerformerDraftEndpoints.Changed(_proposal ?? _screen, proposed);
            _proposal = proposed;
            return new PerformerDraftEvent("answer", taken.Said, duration, Proposal: proposed, Changed: changed);
        }
    }

    private static string Message(string text) => JsonSerializer.Serialize(
        new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        },
        AgentRequest.JsonOptions);

    private static PerformerDraftEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new PerformerDraftEvent("error", "Claude Code не запустился", Output: exit.Error);
        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new PerformerDraftEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? FlowRewriteEndpoints.Shorten(output) : $"код выхода {exit.ExitCode}");
    }

    private sealed class Turn(ChannelWriter<string> replies, string copy, string? flow, bool editing)
    {
        public ChannelWriter<string> Replies { get; } = replies;

        public string Copy { get; } = copy;

        /// <summary>Флоу базы на начало переписки: его получает первая реплика каждого агента.</summary>
        public string? Flow { get; } = flow;

        public bool Editing { get; } = editing;

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

/// <summary>
/// Чудо-Юдо пишет исполнителя с оператором. Агент только читает: он предлагает файл субагента текстом, а разбирает
/// его и пишет — панель, по кнопке «Сохранить» окна исполнителя.
/// </summary>
public static class PerformerDraftEndpoints
{
    /// <summary>Пометка блока с файлом исполнителя в ответе агента.</summary>
    public const string Marker = "=== исполнитель";

    /// <summary>Поля исполнителя в порядке окна — так же их называет Changed.</summary>
    public static readonly IReadOnlyList<string> Fields = ["name", "description", "model", "tools", "prompt"];

    public static void MapPerformerDraftEndpoints(this IEndpointRouteBuilder app)
    {
        // Переписку держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        app.MapPost("/api/performers/draft", async (
            PerformerDraftRequest request,
            BasesStore bases,
            PerformerConversations conversations,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null
                ? null
                : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Wish))
                return Results.BadRequest();

            // Агент работает в основной копии: туда же ляжет файл, и её код он и читает.
            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            if (copies.FirstOrDefault(c => c.Main) is not { } copy)
                return Results.NotFound();

            var subject = string.IsNullOrWhiteSpace(request.Subject) ? null : request.Subject.Trim();
            return Results.Ok(conversations.Start(
                basePath, copy.Path, await FlowAsync(basePath, cancellationToken), request.Wish.Trim(), request.Current, subject));
        });

        app.MapPost("/api/performers/draft/reply", (PerformerDraftReply reply, PerformerConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();
            return conversations.Reply(reply.Text.Trim(), reply.Current) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });

        app.MapPost("/api/performers/draft/stop", (PerformerConversations conversations) =>
            conversations.Stop() ? Results.NoContent() : Results.NotFound());
    }

    /// <summary>Слова ответа и исполнитель из блока «=== исполнитель»; блока нет — Performer null. Error — блок не разобран.</summary>
    public sealed record Taken(string Said, PerformerDraftFields? Performer, string? Error);

    /// <summary>Разбирает блок тем же разбором, каким панель читает файлы исполнителей с диска.</summary>
    public static Taken Take(string answer)
    {
        var lines = answer.ReplaceLineEndings("\n").Split('\n');
        var at = Array.FindIndex(lines, l => l.Trim() == Marker);
        if (at < 0)
            return new Taken(answer.Trim(), null, null);

        var said = string.Join("\n", lines[..at]).Trim();
        var fields = PerformerFile.Parse(FlowRewriteEndpoints.Unfence(string.Join("\n", lines[(at + 1)..])));
        if (fields.Prompt.Length == 0)
            return new Taken(said, null, "Исполнитель без задания: под шапкой файла пусто");
        if (!PerformerFile.ValidName(fields.Name))
            return new Taken(said, null, fields.Name is null
                ? "Исполнитель без имени: в шапке файла нет строки name"
                : $"Именем «{fields.Name}» субагента не зовут: только строчные латинские буквы, цифры и дефис");
        return new Taken(said, new PerformerDraftFields(fields.Name, fields.Description, fields.Model, fields.Tools, fields.Prompt), null);
    }

    public static string Rework(string error) => $"""
        Панель не приняла твой ответ: {error}.
        Верни ответ заново — исполнителя целиком блоком «{Marker}»: шапка между строками «---» с name и остальными
        ключами и задание под ней.
        """;

    /// <summary>Какие поля ответ поменял против того, что было: предложенного прежде или стоящего в окне.</summary>
    public static IReadOnlyList<string> Changed(PerformerDraftFields? was, PerformerDraftFields now)
    {
        string Of(PerformerDraftFields? fields, string key) => (key switch
        {
            "name" => fields?.Name,
            "description" => fields?.Description,
            "model" => fields?.Model,
            "tools" => fields?.Tools,
            _ => fields?.Prompt,
        } ?? "").ReplaceLineEndings("\n").Trim();

        return Fields.Where(key => Of(was, key) != Of(now, key)).ToList();
    }

    /// <summary>
    /// Флоу базы уходит агенту текстом — flow/scenarios.md и файлы этапов: по нему видно, какие у проекта этапы
    /// и кто их сейчас делает. Флоу нет — переписка всё равно идёт: исполнителя заводят и до того, как проект
    /// написал флоу.
    /// </summary>
    private static async Task<string?> FlowAsync(string basePath, CancellationToken cancellationToken)
    {
        try
        {
            if (BaseLayout.Read(basePath) is not { } layout)
                return null;
            var list = Path.Combine(layout.Personal, FlowFolder.ListFile);
            if (!File.Exists(list))
                return null;

            var text = new StringBuilder()
                .Append(FlowFolder.ListFile).Append(":\n").Append(await File.ReadAllTextAsync(list, cancellationToken));
            var stages = Path.Combine(layout.Personal, FlowFolder.StagesFolder);
            if (Directory.Exists(stages))
                foreach (var file in Directory.EnumerateFiles(stages, "*.md").Order(StringComparer.Ordinal))
                    text.Append("\n\n").Append(FlowFolder.StagesFolder).Append('/').Append(Path.GetFileName(file)).Append(":\n")
                        .Append(await File.ReadAllTextAsync(file, cancellationToken));
            return text.ToString();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Агент работает в копии проекта и только читает: файл исполнителя пишет панель. Базу он видит по её пути —
    /// флоу приходит текстом, а остальное знание он дочитывает сам.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string copyPath, string project, bool editing)
    {
        // Исполнители и флоу — свои у каждого оператора: они лежат в его личном репозитории (раскладка кита формата 6).
        var folder = BaseLayout.Read(basePath)?.Personal ?? basePath;
        var agents = Path.Combine(folder, PerformerList.Folder);
        var task = editing
            ? "Оператор правит заведённого исполнителя. Меняй только то, о чём он просит, остальное оставь слово в слово."
            : $"Оператор заводит нового исполнителя. Посмотри, кто уже заведён в каталоге {agents}, и не повторяй ни их имён, ни их работы.";

        var systemPrompt = $"""
            Ты с оператором веб-панели пишешь исполнителя — субагента Claude Code — для проекта «{project}».
            Это переписка: оператор просит и уточняет, ты отвечаешь.
            Текущий каталог — рабочая копия проекта: читай её код, чтобы понять, чем проект сделан и чем
            проверяется работа. База знаний проекта лежит в {basePath}, в ней — решения проекта в decisions/, а в личном
            репозитории оператора {folder} — его флоу: сценарии в flow/scenarios.md и этапы в flow/stages/.
            Флоу приходит текстом с первой репликой.
            {task}
            Поля исполнителя таким, каким их видит оператор в окне, приходят с каждой его репликой; они важнее файла
            на диске. Пустые поля — исполнитель только заводится.
            Чего оператор не сказал и без чего исполнителя не написать — спроси, а не сочиняй. Не спрашивай больше
            трёх вопросов за раз и к каждому предложи свой вариант.
            Исполнителя предлагай в конце ответа блоком: строка «{Marker}» и под ней файл субагента целиком, даже если
            меняется одно слово. До блока — коротко, что ты сделал или о чём спрашиваешь. Не меняешь исполнителя —
            блока нет.
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
        startInfo.ArgumentList.Add("--add-dir");
        startInfo.ArgumentList.Add(basePath);
        return startInfo;
    }

    /// <summary>
    /// Реплика агенту: слова оператора, флоу базы — у первой реплики агента — и поля исполнителя, какими они стоят в окне.
    /// </summary>
    public static string Input(string text, string? flow, PerformerDraftFields? current, bool editing, bool first = true)
    {
        var said = new StringBuilder().Append(first ? "Просьба оператора:\n" : "Оператор:\n").Append(text);
        if (first && flow is not null)
            said.Append("\n\nФлоу оператора, файлы flow/ его личного репозитория:\n").Append(flow);
        said.Append(editing ? "\n\nИсполнитель в окне сейчас:\n" : "\n\nПоля нового исполнителя в окне сейчас:\n");
        if (current is null || Empty(current))
            said.Append("пусто — исполнитель заводится.");
        else
            said.Append(PerformerFile.Serialize(
                new PerformerFields(current.Name, current.Description, current.Model, current.Tools, current.Prompt)).TrimEnd());
        return said.ToString();
    }

    private static bool Empty(PerformerDraftFields fields) =>
        string.IsNullOrWhiteSpace(fields.Name)
        && string.IsNullOrWhiteSpace(fields.Description)
        && string.IsNullOrWhiteSpace(fields.Model)
        && string.IsNullOrWhiteSpace(fields.Tools)
        && string.IsNullOrWhiteSpace(fields.Prompt);
}
