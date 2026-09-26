using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

/// <summary>Number — запись, от которой открыт разговор кнопкой «Изменить»; null — разговор из шапки раздела.</summary>
public sealed record BacklogWriteRequest(string? Base, string? Text, string? Number = null);

public sealed record BacklogProposalRequest(string? Id);

/// <summary>
/// Событие разговора о бэклоге, одной строкой NDJSON. Type: reply — реплика оператора (Number — запись, о которой
/// она); step — ход агента; note — слово панели в переписке; answer — ответ агента (Text без блоков предложения,
/// Entries — новые записи, уже закоммиченные, Commit, Proposal — что ждёт «Сохранить»); error — ход не удался
/// (Text — почему, Output — что вывел агент, Entries — появившиеся записи, если они есть); stopped — ответ оборвал
/// оператор; saved и refused — предложение ProposalId сохранено коммитом Commit или отклонено.
/// </summary>
public sealed record BacklogWriteEvent(
    string Type,
    string Text,
    IReadOnlyList<BacklogEntry>? Entries = null,
    string? Commit = null,
    long? DurationMs = null,
    string? Output = null,
    BacklogProposal? Proposal = null,
    string? ProposalId = null,
    string? Number = null) : IAgentEvent;

/// <summary>Чем кончилось «Сохранить»: Error — почему не записано, Commit — чем записано.</summary>
public sealed record BacklogSaved(string? Commit, string? Error, string? Output = null);

/// <summary>
/// Разговор оператора с агентом о бэклоге одной базы — решение оператора на B-72: оператор просит добавить,
/// изменить, удалить или объединить записи и уточняет в том же окне. Новые записи агент пишет навыком кита и
/// коммитит сам; изменение, удаление и объединение он только предлагает, а записывает их панель по «Сохранить».
/// Память разговора — живой процесс агента, как у вопроса по базе (B-79).
/// </summary>
public sealed class BacklogConversations(IAgentChat agent, AgentRequests requests)
{
    /// <summary>Сколько ждать ответа на одну реплику. Между репликами процесс стоит сколько угодно.</summary>
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    public const string SaveMessage = "Изменить бэклог из панели";

    private readonly object _gate = new();
    private Turn? _turn;
    private Pending? _pending;

    /// <summary>Запись, про которую разговор открыт кнопкой «Изменить»: новый агент после сбоя должен её знать.</summary>
    private string? _about;

    public async Task<AgentRequestSummary> StartAsync(string basePath, string text, string? number)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer);
        var request = requests.Start(
            AgentRequests.Backlog,
            basePath,
            ProjectName.Of(basePath),
            text,
            (writing, cancellationToken) => RunAsync(basePath, replies.Reader, turn, writing, cancellationToken),
            continues: true,
            // Запись разговора видна в списке просьб: «Изменить» у той же записи открывает этот разговор (B-228).
            subject: number);

        turn.Request = request;
        lock (_gate)
        {
            _turn = turn;
            _pending = null;
            _about = number;
        }
        // Навык кита зовётся первой репликой: дальше разговор идёт в нём же. Агент, кончившийся до неё, не
        // поднялся вовсе, и нового ради неё не поднимают: сбой запуска работа уже записала в переписку.
        await SayAsync(request, turn, text, Skill(number, text), number, retried: true);
        return request.Summary;
    }

    public async Task<AskReplied> ReplyAsync(string text)
    {
        if (requests.Of(AgentRequests.Backlog) is not { Continues: true } request)
            return AskReplied.NoConversation;
        if (!request.Finished)
            return AskReplied.Answering;

        Turn? turn;
        lock (_gate)
        {
            // Пока панель пишет предложение, реплика не уходит: агент застал бы бэклог посреди записи.
            if (_pending is { Saving: true })
                return AskReplied.Answering;
            turn = _turn?.Request == request && request.Working && !_turn.Ended ? _turn : null;
            // Пока идёт проверка перед отправкой, кончившийся агент не пишет провал: реплику получит новый.
            turn?.Coming = true;
            // Новая просьба заменяет несохранённое предложение: сохранять его больше нечего.
            _pending = null;
        }

        turn ??= Restart(request);
        await SayAsync(request, turn, text, text, null, retried: false);
        return AskReplied.Sent;
    }

    public bool Stop()
    {
        if (requests.Of(AgentRequests.Backlog) is not { Continues: true } request || request.Finished)
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

    /// <summary>«Отказаться»: предложение уходит несохранённым, и в переписке это видно.</summary>
    public bool Refuse(string id)
    {
        AgentRequest? request;
        lock (_gate)
        {
            if (_pending?.Proposal.Id != id)
                return false;
            request = _pending.Request;
            _pending = null;
        }
        request.Write(new BacklogWriteEvent("refused", "", ProposalId: id));
        return true;
    }

    /// <summary>
    /// «Сохранить»: панель сама меняет и вырезает ровно записи предложения и коммитит только backlog.md. Запись
    /// успели поменять после ответа агента или в файле чужая незакоммиченная правка — ничего не пишется.
    /// null — такого предложения нет: заменено, уже сохранено или отклонено.
    /// </summary>
    public async Task<BacklogSaved?> SaveAsync(string id)
    {
        Pending pending;
        lock (_gate)
        {
            // Предложение живёт, пока жив его разговор и агент не отвечает на новую реплику.
            if (_pending?.Proposal.Id != id || _pending.Saving
                || requests.Of(AgentRequests.Backlog) != _pending.Request || !_pending.Request.Finished)
                return null;
            pending = _pending;
            pending.Saving = true;
        }

        var saved = await WriteAsync(pending.Request.Base, pending.Proposal);
        lock (_gate)
        {
            pending.Saving = false;
            if (saved.Error is null && _pending == pending)
                _pending = null;
        }
        if (saved.Error is null)
            pending.Request.Write(new BacklogWriteEvent("saved", "", Commit: saved.Commit, ProposalId: id));
        return saved;
    }

    private static async Task<BacklogSaved> WriteAsync(string basePath, BacklogProposal proposal)
    {
        var file = Path.Combine(basePath, BacklogWriteEndpoints.BacklogFile);
        switch (await BaseGit.IsDirtyAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None))
        {
            case null:
                return new BacklogSaved(null, "git не прочитал базу — ничего не записано");
            case true:
                return new BacklogSaved(null, "В backlog.md базы есть незакоммиченная правка — ничего не записано");
        }

        byte[] before;
        try
        {
            before = await File.ReadAllBytesAsync(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BacklogSaved(null, $"backlog.md не прочитан: {e.Message}");
        }

        var (decoded, hasBom) = FlowFolder.Decode(before);
        var (text, diverged) = proposal.Apply(decoded);
        if (text is null)
            return new BacklogSaved(null, $"Запись {diverged} изменилась после ответа {AgentRequests.AgentName} — ничего не записано");

        try
        {
            await File.WriteAllBytesAsync(file, FlowFolder.Encode(text, hasBom));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BacklogSaved(null, $"backlog.md не записан: {e.Message}");
        }

        var commit = await BaseGit.CommitFileAsync(basePath, BacklogWriteEndpoints.BacklogFile, SaveMessage, CancellationToken.None);
        if (commit.Error is { } refused)
        {
            // Незакоммиченная правка прихватилась бы чужим коммитом соседней сессии: файл возвращается как был.
            try
            {
                await File.WriteAllBytesAsync(file, before);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return new BacklogSaved(null, "Коммит не прошёл, и backlog.md не вернулся как был", $"{refused}\n{e.Message}");
            }
            return new BacklogSaved(null, "Коммит не прошёл — backlog.md оставлен как был", refused);
        }

        return new BacklogSaved(await BaseGit.LastCommitAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None), null);
    }

    private Turn Restart(AgentRequest request, bool retried = false)
    {
        var replies = Channel.CreateUnbounded<string>();
        // Навык прежнего процесса новый агент не знает: реплика зовёт его снова.
        var turn = new Turn(replies.Writer) { Request = request, Restarted = true, Retried = retried };
        lock (_gate)
            _turn = turn;

        request.Write(new BacklogWriteEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (writing, cancellationToken) => RunAsync(request.Base, replies.Reader, turn, writing, cancellationToken));
        return turn;
    }

    /// <summary>
    /// Агент кончился: его очередь реплик больше не принимает. Возвращает реплику, которая в ней осталась, — её
    /// агент так и не прочёл. Реплика, которая ещё на проверке перед отправкой, получает нового агента, поднятого
    /// здесь же: его работа идёт раньше, чем кончится прежняя, и просьба не закрывается провалом.
    /// </summary>
    private (string? Left, bool HandedOver) End(Turn turn, ChannelReader<string> replies, AgentRequest request)
    {
        lock (_gate)
        {
            turn.Ended = true;
            if (replies.TryRead(out _))
                return (turn.Said, false);
            // Остановленному ответу новый агент не нужен: панель уже пишет, что ответа не будет.
            if (!turn.Coming || turn.Stopped)
                return (null, false);
            turn.Next = Restart(request, retried: true);
            return (null, true);
        }
    }

    /// <summary>
    /// Реплика встаёт в переписку и уходит агенту строкой stdin, если бэклог можно трогать: незакоммиченную
    /// чужую правку агент унёс бы в свой коммит.
    /// </summary>
    private static string Skill(string? number, string text) =>
        number is null ? $"/agents-kit:backlog {text}" : $"/agents-kit:backlog Про запись {number}: {text}";

    private async Task SayAsync(AgentRequest request, Turn turn, string text, string message, string? number, bool retried)
    {
        request.Reply(new BacklogWriteEvent("reply", text, Number: number));
        try
        {
            if (await RefusalAsync(request.Base) is { } refusal)
            {
                // Агент, поднятый вместо кончившегося, пока шла проверка, остаётся ждать следующей реплики: пометка
                // «отвечает заново» уже в переписке, а ответит он на следующую.
                request.Write(refusal);
                return;
            }

            Deliver(request, turn, message, Backlog.Blocks(ReadText(request.Base)!), retried);
        }
        finally
        {
            lock (_gate)
                turn.Coming = false;
        }
    }

    /// <summary>
    /// Реплика уходит в очередь агента под той же блокировкой, которой его работа отмечает свой конец: кончившемуся
    /// агенту она не достаётся, а поднимает нового (B-259). Новый поднимается один раз на реплику — агент, который
    /// сразу кончается, иначе поднимался бы без конца, а его сбой работа уже записала в переписку.
    /// </summary>
    private void Deliver(AgentRequest request, Turn turn, string message, IReadOnlyList<BacklogBlock> before, bool retried)
    {
        while (true)
        {
            lock (_gate)
            {
                if (turn is { Ended: true, Next: { } next })
                {
                    turn = next;
                    retried = true;
                }
                // Оператор остановил ответ, пока реплика шла к агенту: остановленный агент пишет, что ответа не будет.
                if (turn.Stopped)
                    return;
                if (!turn.Ended || retried)
                {
                    turn.Before = before;
                    turn.Said = message;
                    turn.Coming = false;
                    turn.Timeout.CancelAfter(Answer);
                    turn.Replies.TryWrite(Message(turn.Restarted ? Skill(_about, message) : message));
                    turn.Restarted = false;
                    return;
                }
            }

            turn = Restart(request, retried: true);
            retried = true;
        }
    }

    private static async Task<BacklogWriteEvent?> RefusalAsync(string basePath)
    {
        if (WorkspaceCollector.ReadCopies(basePath) is not { } copies || WorkspaceCollector.NewCopySource(copies) is null)
            return new BacklogWriteEvent("error", "Нет основной копии проекта на диске: агенту негде запустить навык записи");
        if (ReadText(basePath) is null)
            return new BacklogWriteEvent("error", "В базе нет backlog.md или он не прочитан");
        return await BaseGit.IsDirtyAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None) switch
        {
            null => new BacklogWriteEvent("error", "git не прочитал базу — просьба не отправлена"),
            true => new BacklogWriteEvent("error", "В backlog.md базы есть незакоммиченная правка — просьба не отправлена"),
            _ => null,
        };
    }

    private async Task RunAsync(
        string basePath,
        ChannelReader<string> replies,
        Turn turn,
        AgentRequest writing,
        CancellationToken cancellationToken)
    {
        // Навык кита работает только там, где кит подаёт базу, — в копии проекта, а не в каталоге базы.
        var copy = WorkspaceCollector.ReadCopies(basePath) is { } copies ? WorkspaceCollector.NewCopySource(copies) : null;
        if (copy is null)
        {
            End(turn, replies, writing);
            return;
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, turn.Timeout.Token);
        var stream = new ClaudeStream(basePath, copy);
        try
        {
            var exit = await agent.RunAsync(
                BacklogWriteEndpoints.StartInfo(basePath, copy),
                replies,
                async line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            writing.Write(new BacklogWriteEvent("step", e.Text));
                        else
                            writing.Write(await OutcomeAsync(basePath, turn, writing, e));
                    }
                    if (stream.Finished)
                    {
                        // Реплику, ради которой агент поднят, он прочёл: следующую, не прочтённую им, получит новый.
                        turn.Retried = false;
                        turn.Timeout.CancelAfter(Timeout.InfiniteTimeSpan);
                        stream = new ClaudeStream(basePath, copy);
                    }
                },
                linked.Token);
            var (left, handedOver) = End(turn, replies, writing);
            if (left is not null && !turn.Retried)
            {
                // Реплика легла в очередь, когда агент уже кончался, и он её не прочёл: её получает новый, если
                // оператор не остановил ответ. Дошедшую до stdin выходящего процесса не вернуть — она кончится
                // провалом ниже.
                if (turn.Stopped)
                    writing.Write(new BacklogWriteEvent(
                        "stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет"));
                else
                    Deliver(writing, Restart(writing, retried: true), left, turn.Before, retried: true);
                return;
            }
            if (handedOver)
                return;
            if (!writing.Finished)
                writing.Write(await OutcomeAsync(basePath, turn, writing, null, Failure(exit, stream)));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            End(turn, replies, writing);
            writing.Write(await OutcomeAsync(basePath, turn, writing, null, turn.Stopped
                ? new BacklogWriteEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет")
                : new BacklogWriteEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен")));
        }
    }

    /// <summary>
    /// Итог реплики по файлу, а не по словам агента: новые записи — номера, которых не было до реплики, и они
    /// должны быть закоммичены. Прежние записи агент трогать не должен — их правку он только предлагает.
    /// </summary>
    private async Task<BacklogWriteEvent> OutcomeAsync(
        string basePath, Turn turn, AgentRequest writing, AskEvent? answer, BacklogWriteEvent? failure = null)
    {
        var before = turn.Before;
        var text = ReadText(basePath);
        var after = text is null ? [] : Backlog.Blocks(text);
        var known = before.Select(b => b.Number).OfType<string>().ToHashSet();
        var letters = text is null ? null : Backlog.Letters(text);
        // Запись чужими буквами навык кита перенумеровывает счётчиком: под новым номером она не новая.
        var foreign = before
            .Where(b => b.Number is not null && BacklogNumber.Letters(b.Number) != letters && after.All(a => a.Number != b.Number))
            .Select(b => Body(b.Text))
            .ToList();
        var renumbered = after
            .Where(a => a.Number is not null && !known.Contains(a.Number) && foreign.Any(f => Extends(Body(a.Text), f)))
            .Select(a => a.Number!)
            .ToHashSet();
        var added = text is null
            ? []
            : Backlog.Parse(text).Where(e => e.Number is { } n && !known.Contains(n) && !renumbered.Contains(n)).ToList();
        // Навык кита, дописывая, сам дополняет записи: строкой в «Агенту» найденной записи, недостающим полем,
        // номером записи чужими буквами. Это не правка — правкой считается то, что убрало или переписало строку.
        var touched = before
            .Where(b => b.Number is not null && BacklogNumber.Letters(b.Number) == letters
                && (after.FirstOrDefault(a => a.Number == b.Number) is not { } now || !Extends(now.Text, b.Text)))
            .Select(b => b.Number!)
            .ToList();
        var entries = added.Count > 0 ? added : null;

        if (failure is not null)
            return failure with { Entries = entries };
        if (answer is not { Type: "answer" })
            return new BacklogWriteEvent("error", answer?.Text ?? "", entries, Output: answer?.Output);

        var (said, blocks) = BacklogProposal.Split(answer.Text);
        var output = said.Length > 0 ? said : null;
        var dirty = await BaseGit.IsDirtyAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None);
        if (touched.Count > 0)
        {
            // Оператору надо знать, где искать правку, сделанную без его «Сохранить»: в истории базы или в файле.
            var where = dirty switch
            {
                true => "правка не закоммичена — backlog.md остался изменённым",
                false when await BaseGit.LastCommitAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None) is { } sha =>
                    $"правка уже в истории базы, коммит {sha}",
                _ => "закоммичена ли правка, git не сказал",
            };
            return new BacklogWriteEvent(
                "error", $"{AgentRequests.AgentName} сам изменил записи {string.Join(", ", touched)} вместо предложения: {where}", entries, Output: output);
        }

        if (dirty is null)
            return new BacklogWriteEvent("error", "git не прочитал базу — итог ответа не проверен", entries, Output: output);
        if (dirty == true)
            return new BacklogWriteEvent("error", "Бэклог изменён, но backlog.md не закоммичен", entries, Output: output);

        var (proposal, wrong) = text is null ? (null, null) : BacklogProposal.Build(blocks, text);
        if (wrong is not null)
            return new BacklogWriteEvent("error", $"{AgentRequests.AgentName} предложил правку, которую панель не поняла: {wrong}", entries, Output: output);

        var commit = entries is null ? null : await BaseGit.LastCommitAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None);
        if (proposal is not null)
            lock (_gate)
                _pending = new Pending(writing, proposal);
        return new BacklogWriteEvent("answer", said, entries, commit, answer.DurationMs, Proposal: proposal);
    }

    /// <summary>Запись только дополнена: все её прежние строки стоят в новой по порядку, а новые лишь вставлены.</summary>
    private static bool Extends(string now, string was)
    {
        var lines = now.Split('\n');
        var old = was.Split('\n');
        var at = 0;
        var agent = false;
        foreach (var line in lines)
        {
            if (line.StartsWith("### "))
                agent = line[4..].Trim() == "Агенту";
            if (at < old.Length && line == old[at])
            {
                at++;
                continue;
            }
            // Навык дописывает только строки «Агенту», сам его заголовок и поля: новая фраза в тексте оператору — правка.
            if (!(agent || line.Trim().Length == 0 || FieldLine.IsMatch(line)))
                return false;
        }
        return at == old.Length;
    }

    private static readonly Regex FieldLine = new(@"^(приоритет|тип):\s");

    /// <summary>Запись без номера в заголовке: по ней узнаётся запись, которую перенумеровали.</summary>
    private static string Body(string text)
    {
        var lines = text.Split('\n');
        var heading = lines[0].Split(' ', 3);
        lines[0] = heading.Length == 3 ? heading[2] : lines[0];
        return string.Join("\n", lines);
    }

    private static string? ReadText(string basePath)
    {
        try
        {
            return File.ReadAllText(Path.Combine(basePath, BacklogWriteEndpoints.BacklogFile));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string Message(string text) => JsonSerializer.Serialize(
        new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        },
        AgentRequest.JsonOptions);

    private static BacklogWriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new BacklogWriteEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new BacklogWriteEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? output : $"код выхода {exit.ExitCode}");
    }

    private sealed class Turn(ChannelWriter<string> replies)
    {
        public ChannelWriter<string> Replies { get; } = replies;

        public CancellationTokenSource Timeout { get; } = new();

        public AgentRequest? Request { get; set; }

        public bool Stopped { get; set; }

        /// <summary>Процесс поднят заново: навык кита новый агент знает, только если реплика его назовёт.</summary>
        public bool Restarted { get; set; }

        /// <summary>Записи бэклога до нынешней реплики: по ним видно, что агент добавил и что тронул.</summary>
        public IReadOnlyList<BacklogBlock> Before { get; set; } = [];

        /// <summary>Процесс кончился: реплика в его очередь уже не идёт. Меняется только под блокировкой разговора.</summary>
        public bool Ended { get; set; }

        /// <summary>Реплика выбрала этот процесс и идёт к нему через проверку перед отправкой.</summary>
        public bool Coming { get; set; }

        /// <summary>Процесс, поднятый вместо кончившегося для реплики, которая шла к этому.</summary>
        public Turn? Next { get; set; }

        /// <summary>Нынешняя реплика без приставки навыка: не прочтённую агентом получает новый.</summary>
        public string? Said { get; set; }

        /// <summary>
        /// Процесс поднят ради реплики, не прочтённой прежним, и ещё на неё не ответил: не прочтёт и он — нового уже
        /// не будет.
        /// </summary>
        public bool Retried { get; set; }
    }

    /// <summary>Предложение, которое ждёт «Сохранить» или «Отказаться».</summary>
    private sealed class Pending(AgentRequest request, BacklogProposal proposal)
    {
        public AgentRequest Request { get; } = request;

        public BacklogProposal Proposal { get; } = proposal;

        public bool Saving { get; set; }
    }
}

public static class BacklogWriteEndpoints
{
    public const string BacklogFile = "backlog.md";

    /// <summary>Сообщение коммита у всех записей из панели одно: оно стоит в правиле разрешения.</summary>
    public const string CommitMessage = "Записать в бэклог из панели";

    public static void MapBacklogWriteEndpoints(this IEndpointRouteBuilder app)
    {
        // Разговор держит панель: POST его заводит и отдаёт сводку, а переписку окно читает потоком просьбы.
        app.MapPost("/api/backlog/write", async (BacklogWriteRequest request, BasesStore bases, BacklogConversations conversations) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Text))
                return Results.BadRequest();

            var number = string.IsNullOrWhiteSpace(request.Number) ? null : BacklogNumber.Normalize(request.Number);
            if (!string.IsNullOrWhiteSpace(request.Number) && number is null)
                return Results.BadRequest();
            return Results.Ok(await conversations.StartAsync(basePath, request.Text.Trim(), number));
        });

        app.MapPost("/api/backlog/write/reply", async (AskReply reply, BacklogConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();

            return await conversations.ReplyAsync(reply.Text.Trim()) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });

        app.MapPost("/api/backlog/write/stop", (BacklogConversations conversations) =>
            conversations.Stop() ? Results.NoContent() : Results.NotFound());

        app.MapPost("/api/backlog/write/save", async (BacklogProposalRequest request, BacklogConversations conversations) =>
            request.Id is null || await conversations.SaveAsync(request.Id) is not { } saved
                ? Results.NotFound()
                : Results.Ok(saved));

        app.MapPost("/api/backlog/write/refuse", (BacklogProposalRequest request, BacklogConversations conversations) =>
            request.Id is not null && conversations.Refuse(request.Id) ? Results.NoContent() : Results.NotFound());
    }

    /// <summary>
    /// Агент видит код копии и базу, но меняет только backlog.md базы и коммитит только его: остальные
    /// инструменты отключены, а режим dontAsk отказывает всему, что не разрешено правилом. Реплики оператора
    /// уходят в stdin — не в аргументы.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string copyPath)
    {
        var backlog = Path.Combine(basePath, BacklogFile);
        // Команда коммита — одна строка и для правила, и для промпта: правило PowerShell со звёздочкой
        // не совпадает с командой git ни в каком виде, совпадает только записанная целиком. Поэтому
        // сообщение коммита пишет панель, а не агент: его текст — часть разрешённой команды.
        var commit = $"git -C \"{basePath}\" commit -m \"{CommitMessage}\" -- {BacklogFile}";
        var systemPrompt = $"""
            Ты ведёшь с оператором разговор о бэклоге базы знаний в веб-панели: он просит и уточняет в том же разговоре.
            Менять можно только файл {backlog}. Коммит — ровно одной командой PowerShell, слово в слово: {commit}
            Сообщение коммита не менять: разрешена ровно эта команда. Другие команды запрещены и не нужны.
            Новые записи дописывай в файл и коммить сразу, по навыку.
            Записи, которые уже есть в файле, не меняй и не удаляй — ни переписыванием, ни удалением, ни объединением.
            Их правку верни предложением в конце ответа, по блоку на запись; панель покажет его оператору и запишет сама:
            ~~~backlog
            изменить B-12
            ## B-12 <заголовок>
            <запись целиком, какой она станет: поля, текст оператору, раздел «### Агенту»>
            ~~~
            ~~~backlog
            удалить B-13
            ~~~
            При объединении запись, которая остаётся, идёт блоком «изменить», а уходящая — «удалить B-13 в B-12».
            Номер записи не меняй, счётчик «следующий номер:» не трогай.
            Запись названа не номером, а описанием — назови найденную запись номером и заголовком и спроси, та ли это;
            предложения до ответа оператора не давай.
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--input-format", "stream-json",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob,Edit,PowerShell,Skill",
                     "--add-dir", basePath,
                     "--permission-mode", "dontAsk",
                     "--allowedTools", "Read", "Grep", "Glob", "Skill",
                     $"Edit({backlog})",
                     $"PowerShell({commit})",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", systemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        return startInfo;
    }
}
