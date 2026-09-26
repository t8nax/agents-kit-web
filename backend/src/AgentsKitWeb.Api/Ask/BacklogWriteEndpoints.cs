using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Number — запись, от которой открыт разговор кнопкой «Изменить»; null — разговор из шапки раздела. Files — файлы,
/// которые оператор приложил к реплике: панель кладёт их копиями в artifacts/ базы.
/// </summary>
public sealed record BacklogWriteRequest(
    string? Base, string? Text, string? Number = null, IReadOnlyList<AttachedFile>? Files = null);

/// <summary>Следующая реплика разговора о бэклоге; Files — приложенные к ней файлы, как у первой.</summary>
public sealed record BacklogReplyRequest(string? Text, IReadOnlyList<AttachedFile>? Files = null);

public sealed record BacklogProposalRequest(string? Id);

/// <summary>
/// Событие разговора о бэклоге, одной строкой NDJSON. Type: reply — реплика оператора (Number — запись, о которой
/// она); step — ход агента; note — слово панели в переписке; answer — ответ агента (Text без блоков предложения,
/// Entries — новые записи, уже закоммиченные, Commit, Proposal — что ждёт «Сохранить»); error — ход не удался
/// (Text — почему, Output — что вывел агент, Entries — появившиеся записи, если они есть); stopped — ответ оборвал
/// оператор; saved и refused — предложение ProposalId сохранено коммитом Commit или отклонено. Files у реплики —
/// адреса artifacts/ приложенных к ней файлов.
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
    string? Number = null,
    IReadOnlyList<string>? Files = null) : IAgentEvent;

/// <summary>
/// Ход перед проверкой базы у каждой реплики разговора о бэклоге. У панели он пустой; тест держит им проверку
/// открытой, пока агент кончается, — иначе исход гонки решала бы скорость git (B-259).
/// </summary>
public interface IBacklogCheckGate
{
    Task BeforeCheckAsync();
}

public sealed class OpenBacklogCheckGate : IBacklogCheckGate
{
    public Task BeforeCheckAsync() => Task.CompletedTask;
}

/// <summary>Чем кончилось «Сохранить»: Error — почему не записано, Commit — чем записано.</summary>
public sealed record BacklogSaved(string? Commit, string? Error, string? Output = null);

/// <summary>
/// Разговор оператора с агентом о бэклоге одной базы — решение оператора на B-72: оператор просит добавить,
/// изменить, удалить или объединить записи и уточняет в том же окне. Новые записи агент пишет навыком кита и
/// коммитит сам; изменение, удаление и объединение он только предлагает, а записывает их панель по «Сохранить».
/// Память разговора — живой процесс агента, как у вопроса по базе (B-79).
/// </summary>
public sealed class BacklogConversations(IAgentChat agent, AgentRequests requests, IBacklogCheckGate checkGate)
{
    /// <summary>Сколько ждать ответа на одну реплику. Между репликами процесс стоит сколько угодно.</summary>
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    public const string SaveMessage = "Изменить бэклог из панели";

    private readonly object _gate = new();
    private Turn? _turn;
    private Pending? _pending;

    /// <summary>Запись, про которую разговор открыт кнопкой «Изменить»: новый агент после сбоя должен её знать.</summary>
    private string? _about;

    /// <summary>Файлы, которые панель положила в artifacts/ за этот разговор и добавила в индекс базы.</summary>
    private readonly List<string> _attached = [];

    public async Task<AgentRequestSummary> StartAsync(string basePath, string text, string? number, IReadOnlyList<AttachedFile> files)
    {
        await DropUnusedAsync();
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
        await SayAsync(request, turn, text, Skill(number, text), number, files, retried: true);
        return request.Summary;
    }

    public async Task<AskReplied> ReplyAsync(string text, IReadOnlyList<AttachedFile> files)
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
        await SayAsync(request, turn, text, text, null, files, retried: false);
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

        List<string> attached;
        lock (_gate)
            attached = [.. _attached];
        var saved = await WriteAsync(pending.Request.Base, pending.Proposal, attached);
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

    private static async Task<BacklogSaved> WriteAsync(string basePath, BacklogProposal proposal, IReadOnlyList<string> attached)
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

        // Файлы artifacts/ записей, которые правка удалила или переписала без них, уходят тем же коммитом,
        // если на них больше никто не ссылается (раскладка кита, «Артефакты»); неотслеживаемый файл git не удалит.
        var orphans = new List<(string Path, byte[] Bytes)>();
        var addresses = proposal.Changes
            .SelectMany(c => Backlog.Parse(c.Original) is [var original, ..] ? original.Artifacts ?? [] : [])
            .Select(a => a.Address);
        foreach (var orphan in ArtifactFiles.Orphans(basePath, addresses, new Dictionary<string, string> { [BacklogWriteEndpoints.BacklogFile] = text }))
        {
            if (!await BaseGit.TrackedAsync(basePath, orphan, CancellationToken.None))
                continue;
            try
            {
                orphans.Add((orphan, await File.ReadAllBytesAsync(Path.Combine(basePath, orphan))));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return new BacklogSaved(null, $"{orphan} не прочитан: {e.Message}");
            }
        }

        // Приложенный в разговоре файл, на который правка сослалась, уходит тем же коммитом, что ссылка.
        var added = new List<string>();
        foreach (var address in attached)
            if (ArtifactFiles.Mentions(text, address) && File.Exists(Path.Combine(basePath, address))
                && !await BaseGit.CommittedAsync(basePath, address, CancellationToken.None))
                added.Add(address);

        try
        {
            await File.WriteAllBytesAsync(file, FlowFolder.Encode(text, hasBom));
            foreach (var (path, _) in orphans)
                File.Delete(Path.Combine(basePath, path));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            var back = await RestoreAsync(basePath, file, before, orphans);
            return new BacklogSaved(null, back is null ? $"backlog.md не записан: {e.Message}" : "backlog.md не записан и не вернулся как был", back);
        }

        foreach (var address in added)
            if ((await BaseGit.AddFileAsync(basePath, address, CancellationToken.None)).Error is { } notAdded)
            {
                await BaseGit.ResetFilesAsync(basePath, added, CancellationToken.None);
                var back = await RestoreAsync(basePath, file, before, orphans);
                return new BacklogSaved(null, "git не принял приложенный файл — ничего не записано", back is null ? notAdded : $"{notAdded}\n{back}");
            }
        var commit = await BaseGit.CommitFilesAsync(
            basePath, [BacklogWriteEndpoints.BacklogFile, .. orphans.Select(o => o.Path), .. added], SaveMessage, CancellationToken.None);
        if (commit.Error is { } refused)
        {
            if (added.Count > 0)
                await BaseGit.ResetFilesAsync(basePath, added, CancellationToken.None);
            // Незакоммиченная правка прихватилась бы чужим коммитом соседней сессии: файлы возвращаются как были.
            if (await RestoreAsync(basePath, file, before, orphans) is { } failed)
                return new BacklogSaved(null, "Коммит не прошёл, и backlog.md не вернулся как был", $"{refused}\n{failed}");
            return new BacklogSaved(null, "Коммит не прошёл — backlog.md оставлен как был", refused);
        }

        return new BacklogSaved(await BaseGit.LastCommitAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None), null);
    }

    // backlog.md и удалённые файлы артефактов — как до записи; null — вернулось, иначе — что помешало.
    private static async Task<string?> RestoreAsync(
        string basePath, string file, byte[] before, IReadOnlyList<(string Path, byte[] Bytes)> orphans)
    {
        try
        {
            await File.WriteAllBytesAsync(file, before);
            foreach (var (path, bytes) in orphans)
                await File.WriteAllBytesAsync(Path.Combine(basePath, path), bytes);
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return e.Message;
        }
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

    private async Task SayAsync(
        AgentRequest request, Turn turn, string text, string message, string? number, IReadOnlyList<AttachedFile> files, bool retried)
    {
        // Реплика без файлов встаёт в переписку сразу; с файлами — когда известно, легли ли они и под какими адресами:
        // по ней окно узнаёт, что стало с приложенным (B-260).
        var replied = false;
        void Reply(IReadOnlyList<string>? attached = null)
        {
            if (replied)
                return;
            replied = true;
            request.Reply(new BacklogWriteEvent("reply", text, Number: number, Files: attached));
        }
        if (files.Count == 0)
            Reply();
        try
        {
            await checkGate.BeforeCheckAsync();
            if (await RefusalAsync(request.Base, files.Count > 0) is { } refusal)
            {
                // Агент, поднятый вместо кончившегося, пока шла проверка, остаётся ждать следующей реплики: пометка
                // «отвечает заново» уже в переписке, а ответит он на следующую.
                Reply();
                request.Write(refusal);
                return;
            }

            IReadOnlyList<string> attached = [];
            if (files.Count > 0)
            {
                string? about;
                lock (_gate)
                    about = _about;
                var (saved, problem) = await AttachAsync(request.Base, files, number ?? about);
                if (saved is null)
                {
                    Reply();
                    request.Write(new BacklogWriteEvent("error", problem!));
                    return;
                }
                attached = saved;
                // Навык кладёт приложенный файл копией в artifacts/ сам; здесь копия уже лежит, и навыку остаётся строка.
                message += $"\n\nОператор приложил файлы — их копии уже лежат в базе и добавлены в индекс git: {string.Join(", ", attached)}."
                    + " Впиши каждый строкой в «### Артефакты» записи, к которой он относится, и коммить командой с artifacts.";
            }
            // Приложенное к реплике ложится в индекс только на ход агента: коммит с artifacts его берёт, а между
            // ходами индекс базы чист — брошенный разговор его не оставит в нём.
            if (await StageAsync(request.Base, attached) is { } unstaged)
            {
                // Реплика ушла без файлов: положенные копии без ссылки в базе не остаются, окно предложит приложить снова.
                lock (_gate)
                    _attached.RemoveAll(attached.Contains);
                ArtifactFiles.Delete(request.Base, attached);
                Reply();
                request.Write(new BacklogWriteEvent("error", unstaged));
                return;
            }
            Reply(attached.Count > 0 ? attached : null);

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

    private async Task<BacklogWriteEvent?> RefusalAsync(string basePath, bool withFiles)
    {
        if (WorkspaceCollector.ReadCopies(basePath) is not { } copies || WorkspaceCollector.NewCopySource(copies) is null)
            return new BacklogWriteEvent("error", "Нет основной копии проекта на диске: агенту негде запустить навык записи");
        if (ReadText(basePath) is null)
            return new BacklogWriteEvent("error", "В базе нет backlog.md или он не прочитан");
        switch (await BaseGit.IsDirtyAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None))
        {
            case null:
                return new BacklogWriteEvent("error", "git не прочитал базу — просьба не отправлена");
            case true:
                return new BacklogWriteEvent("error", "В backlog.md базы есть незакоммиченная правка — просьба не отправлена");
        }

        // Коммит агента с artifacts, которым уходят приложенные файлы, берёт всё незакоммиченное в каталоге: чужая
        // правка там уехала бы с ним. Чужой индекс панель не трогает — реплика с файлами ждёт, пока его закоммитят;
        // реплика без файлов коммитится только backlog.md, и её это не касается.
        if (!withFiles)
            return null;
        var changes = await BaseGit.ChangesAsync(basePath, ArtifactFiles.Folder, CancellationToken.None);
        if (changes is null)
            return new BacklogWriteEvent("error", "git не прочитал базу — просьба не отправлена");
        lock (_gate)
            if (changes.FirstOrDefault(path => !_attached.Contains(path, StringComparer.OrdinalIgnoreCase)) is { } foreign)
                return new BacklogWriteEvent(
                    "error", $"В artifacts/ базы есть незакоммиченная правка {foreign} — приложить файл нельзя, пока её не закоммитят");
        return null;
    }

    /// <summary>
    /// Приложенные файлы — копиями в artifacts/ базы; в индекс их кладёт ход агента (StageAsync). Не легли — ни одного
    /// не остаётся, и слова, почему, идут в переписку.
    /// </summary>
    private async Task<(IReadOnlyList<string>? Saved, string? Problem)> AttachAsync(
        string basePath, IReadOnlyList<AttachedFile> files, string? number)
    {
        IReadOnlyList<string>? saved;
        AttachRejected? rejected;
        try
        {
            (saved, rejected) = await ArtifactFiles.SaveAsync(basePath, files, number, CancellationToken.None);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return (null, $"Файл не положен в базу: {e.Message}");
        }
        if (rejected is not null)
            return (null, ArtifactFiles.Refusal(rejected));

        lock (_gate)
            _attached.AddRange(saved!);
        return (saved, null);
    }

    /// <summary>
    /// Перед ходом агента — файлы этой реплики в индекс базы: коммит агента с artifacts иначе их не увидит. Прежние
    /// приложенные туда не кладутся: файл, от которого оператор отказался, ушёл бы с чужим коммитом без ссылки, — а
    /// сосланный в этом ходе докоммичивает SettleAsync. null — легли; иначе — почему нет, и индекс снят обратно.
    /// </summary>
    private static async Task<string?> StageAsync(string basePath, IReadOnlyList<string> files)
    {
        var staged = new List<string>();
        foreach (var address in files)
        {
            if (await BaseGit.CommittedAsync(basePath, address, CancellationToken.None))
                continue;
            if ((await BaseGit.AddFileAsync(basePath, address, CancellationToken.None)).Error is { } error)
            {
                await BaseGit.ResetFilesAsync(basePath, staged, CancellationToken.None);
                return $"git не принял приложенный файл: {error}";
            }
            staged.Add(address);
        }
        return null;
    }

    /// <summary>
    /// Конец хода: приложенные за разговор файлы, на которые закоммиченный бэклог уже ссылается, уходят в историю — их
    /// докоммичивает панель, если агент их не взял; остальные снимаются с индекса и ждут на диске следующего хода.
    /// null — всё так; иначе — что не вышло.
    /// </summary>
    private async Task<string?> SettleAsync(string basePath)
    {
        var uncommitted = new List<string>();
        foreach (var address in OnDisk(basePath))
            if (!await BaseGit.CommittedAsync(basePath, address, CancellationToken.None))
                uncommitted.Add(address);
        if (uncommitted.Count == 0)
            return null;
        var staged = await BaseGit.ChangesAsync(basePath, ArtifactFiles.Folder, CancellationToken.None);
        if (staged is null)
            return "git не прочитал базу — приложенные файлы не проверены";

        string? problem = null;
        var text = ReadText(basePath) ?? "";
        var referenced = await BaseGit.IsDirtyAsync(basePath, BacklogWriteEndpoints.BacklogFile, CancellationToken.None) == false
            ? uncommitted.Where(a => ArtifactFiles.Mentions(text, a)).ToList()
            : [];
        foreach (var address in referenced)
            if ((await BaseGit.AddFileAsync(basePath, address, CancellationToken.None)).Error is { } notAdded)
                problem ??= $"git не принял приложенный файл: {notAdded}";
        if (problem is null && referenced.Count > 0
            && (await BaseGit.CommitFilesAsync(basePath, referenced, BacklogWriteEndpoints.CommitMessage, CancellationToken.None)).Error is { } refused)
            problem = $"Приложенные файлы не закоммичены: {refused}";
        // Закоммиченное из индекса ушло само; не вышло — снимается и то, что панель сама туда положила.
        var left = problem is null
            ? uncommitted.Where(a => !referenced.Contains(a) && staged.Contains(a, StringComparer.OrdinalIgnoreCase)).ToList()
            : uncommitted.Where(a => referenced.Contains(a) || staged.Contains(a, StringComparer.OrdinalIgnoreCase)).ToList();
        if (left.Count > 0)
            await BaseGit.ResetFilesAsync(basePath, left, CancellationToken.None);
        return problem;
    }

    /// <summary>Приложенные за разговор файлы, которые ещё лежат на диске.</summary>
    private List<string> OnDisk(string basePath)
    {
        lock (_gate)
            return [.. _attached.Where(a => File.Exists(Path.Combine(basePath, a)))];
    }

    /// <summary>
    /// Новый разговор: файлы прошлого, на которые бэклог так и не сослался, удаляются — иначе они висели бы в базе
    /// без ссылки. Закоммиченное не трогается.
    /// </summary>
    private async Task DropUnusedAsync()
    {
        string? basePath;
        List<string> attached;
        lock (_gate)
        {
            basePath = _turn?.Request?.Base;
            attached = [.. _attached];
            _attached.Clear();
        }
        if (basePath is null || attached.Count == 0)
            return;

        var text = ReadText(basePath) ?? "";
        var unused = new List<string>();
        foreach (var address in attached)
            if (!ArtifactFiles.Mentions(text, address) && !await BaseGit.CommittedAsync(basePath, address, CancellationToken.None))
                unused.Add(address);
        if (unused.Count == 0)
            return;
        await BaseGit.ResetFilesAsync(basePath, unused, CancellationToken.None);
        ArtifactFiles.Delete(basePath, unused);
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
        var outcome = await ReadOutcomeAsync(basePath, turn, writing, answer, failure);
        // Ход кончился как угодно — приложенное не остаётся в индексе базы.
        if (await SettleAsync(basePath) is not { } unsettled || outcome.Type != "answer")
            return outcome;
        // Ответ стал ошибкой: предложение из него оператор не увидит, и «Сохранить» его не должно ждать.
        lock (_gate)
            if (_pending?.Proposal == outcome.Proposal)
                _pending = null;
        return new BacklogWriteEvent("error", unsettled, outcome.Entries, Output: outcome.Text.Length > 0 ? outcome.Text : null);
    }

    private async Task<BacklogWriteEvent> ReadOutcomeAsync(
        string basePath, Turn turn, AgentRequest writing, AskEvent? answer, BacklogWriteEvent? failure)
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
        var appendable = false;
        foreach (var line in lines)
        {
            if (line.StartsWith("### "))
                appendable = line[4..].Trim() is "Агенту" or Backlog.ArtifactsSection;
            if (at < old.Length && line == old[at])
            {
                at++;
                continue;
            }
            // Навык дописывает только строки «Агенту» и «Артефакты» (приложенный файл), их заголовки и поля:
            // новая фраза в тексте оператору — правка.
            if (!(appendable || line.Trim().Length == 0 || FieldLine.IsMatch(line)))
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
            if (ArtifactFiles.Check(request.Files ?? []) is { } rejected)
                return Results.BadRequest(rejected);

            var number = string.IsNullOrWhiteSpace(request.Number) ? null : BacklogNumber.Normalize(request.Number);
            if (!string.IsNullOrWhiteSpace(request.Number) && number is null)
                return Results.BadRequest();
            return Results.Ok(await conversations.StartAsync(basePath, request.Text.Trim(), number, request.Files ?? []));
        });

        app.MapPost("/api/backlog/write/reply", async (BacklogReplyRequest reply, BacklogConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();
            if (ArtifactFiles.Check(reply.Files ?? []) is { } rejected)
                return Results.BadRequest(rejected);

            return await conversations.ReplyAsync(reply.Text.Trim(), reply.Files ?? []) switch
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
        // Приложенные файлы панель уже положила в artifacts/ и в индекс; их имена меняются от реплики к реплике,
        // а правило пускает только команду целиком — поэтому вторая команда берёт каталог.
        var withFiles = $"{commit} {ArtifactFiles.Folder}";
        var systemPrompt = $"""
            Ты ведёшь с оператором разговор о бэклоге базы знаний в веб-панели: он просит и уточняет в том же разговоре.
            Менять можно только файл {backlog}. Коммит — ровно одной командой PowerShell, слово в слово: {commit}
            Если к реплике приложены файлы и ты вписал их в «### Артефакты» — коммит ровно этой командой: {withFiles}
            Сообщение коммита не менять: разрешены ровно эти команды. Другие команды запрещены и не нужны.
            Новые записи дописывай в файл и коммить сразу, по навыку.
            Записи, которые уже есть в файле, не меняй и не удаляй — ни переписыванием, ни удалением, ни объединением.
            Их правку верни предложением в конце ответа, по блоку на запись; панель покажет его оператору и запишет сама:
            ~~~backlog
            изменить B-12
            ## B-12 <заголовок>
            <запись целиком, какой она станет: поля, текст оператору, разделы «### Артефакты» и «### Агенту»>
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
                     $"PowerShell({withFiles})",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", systemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        return startInfo;
    }
}
