using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>Шаг отката задачи копии: база и копия из списка панели, а не путь, и имя шага (TaskRollback.Steps).</summary>
public sealed record RollbackStepRequest(string? Base, string? Copy, string? Step);

/// <summary>
/// Что окно отката знает до нажатия. Source — откуда задача (RollbackSource): от него зависит, вернётся ли запись
/// в бэклог. Dirty — в копии есть несохранённые правки, и откат их сотрёт. Unpushed — в ветке задачи есть коммиты,
/// которых нет на сервере, и с удалением ветки они пропадут. OnGitHub — ветка задачи есть на сервере и там останется;
/// удалять откату нечего — тоже да. Blockers — сессии, которые откат гасить не станет: пока они живы, он отказывает.
/// </summary>
public sealed record RollbackPlan(
    string Task, string Source, bool Dirty, IReadOnlyList<RollbackBlocker> Blockers, bool Unpushed = false, bool OnGitHub = true);

/// <summary>
/// Сессия, которая мешает откату: Kind — vscode, terminal или background (фоновая, но не сессия задачи), Name — имя
/// сессии, если оно есть.
/// </summary>
public sealed record RollbackBlocker(string Kind, string? Name);

/// <summary>Почему шаг не прошёл: problem — чем именно, message — что сказали git или claude.</summary>
public sealed record RollbackProblem(string Problem, string? Message = null);

public static class RollbackSource
{
    public const string Backlog = "backlog";
    public const string Tracker = "tracker";

    /// <summary>Задача взята словами оператора: в бэклог возвращать нечего.</summary>
    public const string None = "none";
}

/// <summary>
/// Откат задачи, которая ещё в работе, — решения оператора на B-108. Шаги идут по одному, каждый своим запросом:
/// окно отмечает сделанное по ходу, а упавший шаг останавливает откат, и сделанное остаётся. Повторный откат проходит
/// все шаги снова, и шаг, сделанный прошлым откатом, ничего не меняет. Память задачи снимается последней: пока она
/// есть, копия числится занятой и откат можно повторить; после неё шаги отвечают, что задачи уже нет.
/// </summary>
public static partial class TaskRollback
{
    public const string Session = "session";
    public const string Backlog = "backlog";
    public const string Copy = "copy";
    public const string Memory = "memory";

    public static readonly IReadOnlyList<string> Steps = [Session, Backlog, Copy, Memory];

    // Сброс копии и коммит базы могут идти долго на большой копии или с хуком сверки кита.
    private static readonly TimeSpan GitTimeout = TimeSpan.FromSeconds(60);

    // Строка `git status --porcelain`: два знака состояния и пробел. GitRunner обрезает края вывода, и у первой
    // строки « M file» пропадает ведущий пробел — поэтому знаков один или два. Предупреждения git, которые GitRunner
    // кладёт в тот же вывод, начинаются словом и правками не считаются.
    [GeneratedRegex(@"^[ MTADRCU?!]{1,2} \S")]
    private static partial Regex StatusLine { get; }

    public static void MapTaskRollbackEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/tasks/rollback", async (
            string? @base,
            string? copy,
            BasesStore bases,
            AgentSessions sessions,
            TaskSessions taskSessions,
            CancellationToken cancellationToken) =>
        {
            var (target, refused) = await FindAsync(@base, copy, bases, sessions, taskSessions, cancellationToken);
            if (target is null)
                return refused!;

            var status = await GitRunner.RunAsync(target.Row.Path, GitTimeout, cancellationToken, "status", "--porcelain");
            var dirty = status.ExitCode != 0 || status.Output.Split('\n').Any(line => StatusLine.IsMatch(line));
            var branches = await BranchesAsync(target);
            var (unpushed, onGitHub) = branches is { Deleted: { } deleted }
                ? (await UnpushedAsync(branches.Root, deleted), await OnServerAsync(branches.Root, deleted))
                : (false, true);
            return Results.Ok(new RollbackPlan(
                target.Memory.Task ?? "",
                target.Source,
                dirty,
                Blockers(sessions, taskSessions, target, branches?.Root),
                unpushed,
                onGitHub));
        });

        app.MapPost("/api/tasks/rollback", async (
            RollbackStepRequest request,
            BasesStore bases,
            AgentSessions sessions,
            TaskSessions taskSessions,
            StartedTasks started,
            IAgentProcess agent,
            CancellationToken cancellationToken) =>
        {
            if (request.Step is not { } step || !Steps.Contains(step))
                return Results.BadRequest();
            var (target, refused) = await FindAsync(request.Base, request.Copy, bases, sessions, taskSessions, cancellationToken);
            if (target is null)
                return refused!;
            // Сессию своего окна и чужую фоновую панель не гасит: их закрывает оператор, и до того копию не трогают.
            var branches = await BranchesAsync(target);
            if (Blockers(sessions, taskSessions, target, branches?.Root) is [_, ..] blockers)
                return Results.Conflict(new RollbackProblem("blocked", string.Join(", ", blockers.Select(b => b.Kind).Distinct())));

            // Начавшись, шаг отменой запроса не рвётся: оборванный git оставил бы базу или копию на полпути.
            var failure = step switch
            {
                Session => await StopTaskSessionAsync(target, sessions, taskSessions, started, agent),
                Backlog => await ReturnEntryAsync(target),
                Copy => branches is null ? "git не прочитал копию" : await ResetCopyAsync(branches),
                _ => await RemoveMemoryAsync(target),
            };
            return failure is null
                ? Results.NoContent()
                : Results.BadRequest(new RollbackProblem("failed", failure));
        });
    }

    /// <summary>Копия с задачей в работе: строка таблицы, её память и откуда задача.</summary>
    private sealed record Target(BaseLayout Layout, WorkspaceRow Row, string MemoryFile, WorkMemory Memory, string Source, string? Number);

    private static async Task<(Target?, IResult?)> FindAsync(
        string? basePath, string? copy, BasesStore bases, AgentSessions sessions, TaskSessions taskSessions,
        CancellationToken cancellationToken)
    {
        var listed = basePath is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        if (listed is null || BaseLayout.Read(listed) is not { } layout)
            return (null, Results.NotFound());
        if (string.IsNullOrWhiteSpace(copy))
            return (null, Results.BadRequest());

        // Копия берётся из тех же строк, что и таблица: путь из запроса сам по себе прав не даёт.
        var rows = sessions.Annotate(await WorkspaceCollector.CollectAsync([listed], cancellationToken), taskSessions.SessionIn);
        var row = rows.FirstOrDefault(r => r.Error is null && WorkspaceCollector.Normalize(r.Path)
            .Equals(WorkspaceCollector.Normalize(copy), StringComparison.OrdinalIgnoreCase));
        if (row is null)
            return (null, Results.NotFound());

        // Откатывают задачу, у которой есть память: свободной копии откатывать нечего.
        if (!WorkspaceCollector.MemoryFiles(layout).TryGetValue(WorkspaceCollector.FullPath(row.Path), out var memory))
            return (null, Results.Conflict(new RollbackProblem("no-task")));

        var task = memory.Memory.Task ?? "";
        var (source, number) = ProjectTracker.IssueNameAtStart(task) is not null
            ? (RollbackSource.Tracker, null)
            : BacklogNumber.OfTask(task, row.Letters) is { } found
                ? (RollbackSource.Backlog, found)
                : (RollbackSource.None, (string?)null);
        return (new Target(layout, row, memory.File, memory.Memory, source, number), null);
    }

    /// <summary>
    /// Сессии, которые откат гасить не станет, а они правили бы копию, которую он возвращает: сессии своего окна —
    /// VS Code и терминала — и фоновые, кроме сессии задачи. Сброс идёт по всему дереву копии, поэтому сессия
    /// в его подкаталоге мешает так же.
    /// </summary>
    private static List<RollbackBlocker> Blockers(AgentSessions sessions, TaskSessions taskSessions, Target target, string? root)
    {
        var tree = WorkspaceCollector.Normalize(root ?? target.Row.Path);
        var task = taskSessions.SessionIn(target.Row.Path);
        return sessions.Live()
            .Where(s =>
            {
                var cwd = WorkspaceCollector.Normalize(s.Cwd);
                return cwd.Equals(tree, StringComparison.OrdinalIgnoreCase) || cwd.StartsWith(tree + '\\', StringComparison.OrdinalIgnoreCase);
            })
            .Where(s => !(s.InBackground && s.JobId == task))
            .Select(s => new RollbackBlocker(s.InVsCode ? "vscode" : s.InBackground ? "background" : "terminal", s.Name))
            .ToList();
    }

    /// <summary>
    /// Гасит сессию задачи — ту, что панель завела в копии под задачу, — и забывает свой запуск: иначе копия
    /// числилась бы запускаемой. Сессии задачи нет в живых — гасить нечего.
    /// </summary>
    private static async Task<string?> StopTaskSessionAsync(
        Target target, AgentSessions sessions, TaskSessions taskSessions, StartedTasks started, IAgentProcess agent)
    {
        if (sessions.BackgroundIn(target.Row.Path, taskSessions.SessionIn(target.Row.Path)) is { } session
            && await SessionStop.StopAsync(agent, session, CancellationToken.None) is { } failure)
            return $"Сессия задачи не погасла: {failure}";
        started.Forget(target.Row.Path);
        taskSessions.Forget(target.Row.Path);
        return null;
    }

    /// <summary>
    /// Возвращает запись бэклога тем же номером и тем же текстом, какой она была, когда её взяли, — в конец
    /// backlog.md; счётчик номеров не трогается. Текст берётся из истории: из родителя коммита, который её вырезал.
    /// Запись уже в бэклоге — шаг сделан прошлым откатом. Пишет под тем же замком, что «Сохранить» Чудо-Юдо
    /// и перенос записи в трекер: иначе один коммит прихватил бы незакоммиченную правку другого.
    /// </summary>
    private static async Task<string?> ReturnEntryAsync(Target target)
    {
        if (target.Source != RollbackSource.Backlog || target.Number is not { } number)
            return null;

        await BacklogTracker.Writing.WaitAsync();
        try
        {
            return await ReturnEntryAsync(target.Layout, number);
        }
        finally
        {
            BacklogTracker.Writing.Release();
        }
    }

    private static async Task<string?> ReturnEntryAsync(BaseLayout layout, string number)
    {
        var personal = layout.Personal;
        var file = layout.BacklogFile;
        switch (await BaseGit.IsDirtyAsync(personal, BaseLayout.BacklogName, CancellationToken.None))
        {
            case null:
                return "git не прочитал личный репозиторий — запись не возвращена";
            case true:
                return "В backlog.md личного репозитория есть незакоммиченная правка — запись не возвращена";
        }

        byte[] before;
        try
        {
            before = await File.ReadAllBytesAsync(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return $"backlog.md не прочитан: {e.Message}";
        }
        var (text, hasBom) = FlowFolder.Decode(before);
        if (Workspaces.Backlog.Blocks(text).Any(b => b.Number == number))
            return null;

        if (await TakenEntryAsync(personal, number) is not { } entry)
            return $"Запись {number} не нашлась в истории бэклога — вернуть её нечем";

        try
        {
            await File.WriteAllBytesAsync(file, FlowFolder.Encode(Appended(text, entry), hasBom));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return await RestoreAsync(file, before) is null
                ? $"backlog.md не записан: {e.Message}"
                : "backlog.md не записан и не вернулся как был";
        }

        var commit = await BaseGit.CommitFileAsync(
            personal, BaseLayout.BacklogName, $"Вернуть {number} в бэклог: откат задачи из панели", CancellationToken.None);
        if (commit.Error is { } refused)
        {
            // Незакоммиченная правка уехала бы с чужим коммитом соседней сессии: файл возвращается как был.
            return await RestoreAsync(file, before) is { } failed
                ? $"Коммит не прошёл, и backlog.md не вернулся как был: {refused}\n{failed}"
                : $"Коммит не прошёл — backlog.md оставлен как был: {refused}";
        }
        return null;
    }

    /// <summary>Запись с номером, какой она была перед коммитом, вырезавшим её; null — такого коммита нет.</summary>
    private static async Task<string?> TakenEntryAsync(string personal, string number)
    {
        var log = await GitRunner.RunAsync(
            personal, GitTimeout, CancellationToken.None, "log", "--format=%H", "-S", $"## {number} ", "--", BaseLayout.BacklogName);
        if (log.ExitCode != 0)
            return null;
        foreach (var sha in log.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var after = await GitRunner.RunAsync(personal, GitTimeout, CancellationToken.None, "show", $"{sha}:{BaseLayout.BacklogName}");
            if (after.ExitCode == 0 && Workspaces.Backlog.Blocks(after.Output).Any(b => b.Number == number))
                continue;
            var parent = await GitRunner.RunAsync(personal, GitTimeout, CancellationToken.None, "show", $"{sha}^:{BaseLayout.BacklogName}");
            if (parent.ExitCode == 0 && Workspaces.Backlog.Blocks(parent.Output).FirstOrDefault(b => b.Number == number) is { } block)
                return block.Text;
        }
        return null;
    }

    /// <summary>
    /// Запись в конце файла, через пустую строку, с переводами строк, какие у файла. Прежний текст остаётся как был:
    /// дописываются только перевод строки, если файл без него кончается, и пустая строка, если её там нет.
    /// </summary>
    internal static string Appended(string text, string entry)
    {
        var newline = text.Contains("\r\n") ? "\r\n" : "\n";
        var body = text;
        if (body.Length > 0 && !body.EndsWith('\n'))
            body += newline;
        if (body.Length > 0 && !body.EndsWith(newline + newline) && !body.EndsWith("\n\n"))
            body += newline;
        return body + entry.Replace("\n", newline) + newline;
    }

    /// <summary>
    /// Ветки копии для отката. Root — корень её дерева, где идёт git. Previous — ветка, на которой копия стояла до
    /// задачи: имя каталога дерева, как его заводит кит (worktree-add.ps1), у основной копии — master. Deleted — ветка
    /// задачи, которую откат удалит; null — удалять нечего: её нет на компьютере, она и есть прежняя или общая.
    /// </summary>
    private sealed record Branches(string Root, string Previous, string Current, string? Deleted);

    private static async Task<Branches?> BranchesAsync(Target target)
    {
        var copy = WorkspaceCollector.Normalize(target.Row.Path);
        if (await GitWorktrees.ListAsync(copy, CancellationToken.None) is not [var main, ..] worktrees)
            return null;
        var worktree = worktrees
            .Where(w => copy.Equals(WorkspaceCollector.Normalize(w.Path), StringComparison.OrdinalIgnoreCase)
                || copy.StartsWith(WorkspaceCollector.Normalize(w.Path) + '\\', StringComparison.OrdinalIgnoreCase))
            .MaxBy(w => w.Path.Length);
        if (worktree is null)
            return null;

        var root = WorkspaceCollector.Normalize(worktree.Path);
        var previous = root.Equals(WorkspaceCollector.Normalize(main.Path), StringComparison.OrdinalIgnoreCase)
            ? "master"
            : Path.GetFileName(root);
        var task = target.Memory.Branch is { Length: > 0 } branch && branch != "отсоединён" ? branch : worktree.Branch;
        // Общие ветки проекта откат не удаляет, даже если задача шла прямо в них.
        var deleted = task == previous || task is "master" or "dev" or "отсоединён" || !await BranchExistsAsync(root, task)
            ? null
            : task;
        return new Branches(root, previous, worktree.Branch, deleted);
    }

    private static async Task<bool> BranchExistsAsync(string root, string branch) =>
        (await GitRunner.RunAsync(root, GitTimeout, CancellationToken.None, "rev-parse", "--verify", "-q", $"refs/heads/{branch}")).ExitCode == 0;

    /// <summary>В ветке есть коммиты, которых нет ни в одной ветке сервера: с удалением ветки они пропадут.</summary>
    private static async Task<bool> UnpushedAsync(string root, string branch)
    {
        var run = await GitRunner.RunAsync(root, GitTimeout, CancellationToken.None, "rev-list", "--count", $"refs/heads/{branch}", "--not", "--remotes");
        return run.ExitCode != 0 || !int.TryParse(run.Output.Split('\n')[^1].Trim(), out var count) || count > 0;
    }

    /// <summary>Ветка есть на сервере — по последнему, что о нём знает копия.</summary>
    private static async Task<bool> OnServerAsync(string root, string branch) =>
        (await GitRunner.RunAsync(root, GitTimeout, CancellationToken.None, "rev-parse", "--verify", "-q", $"refs/remotes/origin/{branch}")).ExitCode == 0;

    /// <summary>
    /// Возвращает копию на ветку, на которой она стояла до задачи, и стирает несохранённые правки; ветка задачи
    /// удаляется на компьютере, а на GitHub остаётся — решение оператора на макете B-108. Прежняя ветка проверяется
    /// до сброса: без неё шаг падает, ничего не стерев.
    /// </summary>
    private static async Task<string?> ResetCopyAsync(Branches branches)
    {
        var (root, previous, current, deleted) = branches;
        if (current != previous && !await BranchExistsAsync(root, previous))
            return $"Ветки {previous}, на которой копия стояла до задачи, на компьютере нет — копия не тронута";

        // Неотслеживаемые файлы — тоже несохранённые правки; игнорируемые (субагенты кита, сборки) остаются.
        if (await GitAsync(root, "reset", "--hard", "-q") is { } notReset)
            return $"Несохранённые правки не стёрлись: {notReset}";
        if (await GitAsync(root, "clean", "-fdq") is { } notCleaned)
            return $"Новые файлы не стёрлись: {notCleaned}";
        if (current != previous && await GitAsync(root, "switch", "-q", previous) is { } notSwitched)
            return $"Копия не перешла на ветку {previous}: {notSwitched}";

        if (deleted is null)
            return null;
        return await GitAsync(root, "branch", "-D", deleted) is { } notDeleted
            ? $"Ветка задачи {deleted} не удалилась: {notDeleted}"
            : null;
    }

    private static async Task<string?> GitAsync(string root, params string[] args)
    {
        var run = await GitRunner.RunAsync(root, GitTimeout, CancellationToken.None, args);
        return run.ExitCode == 0 ? null : run.Output.Length > 0 ? run.Output : "git ничего не сказал";
    }

    /// <summary>
    /// Снимает память задачи вместе с её флоу и артефактами, на которые больше никто не ссылается, — одним коммитом
    /// личного репозитория, как кит закрывает задачу. Отказ коммита возвращает файлы как были: удаление без коммита
    /// уехало бы с чужим коммитом соседней сессии.
    /// </summary>
    private static async Task<string?> RemoveMemoryAsync(Target target)
    {
        var personal = target.Layout.Personal;
        string Relative(string file) => Path.GetRelativePath(personal, file).Replace('\\', '/');

        var flow = Path.Combine(Path.GetDirectoryName(target.MemoryFile)!, Path.GetFileNameWithoutExtension(target.MemoryFile));
        var files = new List<string> { target.MemoryFile };
        if (Directory.Exists(flow))
            files.AddRange(Directory.EnumerateFiles(flow, "*", SearchOption.AllDirectories));

        var addresses = target.Memory.Artifacts.Select(a => a.Address).Where(ArtifactFiles.InBase);
        var orphans = ArtifactFiles.Orphans(personal, addresses, files.ToDictionary(Relative, _ => ""))
            .Select(orphan => Path.Combine(personal, orphan));

        // Всё, что спрашивается у диска и git, спрашивается до удаления. Байты, а не текст: отказ коммита
        // возвращает файл ровно таким, каким он лежал.
        var kept = new List<(string File, byte[] Bytes)>();
        var tracked = new List<string>();
        foreach (var file in files.Concat(orphans))
        {
            try
            {
                kept.Add((file, await File.ReadAllBytesAsync(file)));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return $"{Relative(file)} не прочитан: {e.Message}";
            }
            switch (await BaseGit.TrackingAsync(personal, Relative(file), CancellationToken.None))
            {
                case null:
                    return "git не прочитал личный репозиторий — память задачи не снята";
                case true:
                    tracked.Add(Relative(file));
                    break;
            }
        }

        try
        {
            foreach (var (file, _) in kept)
                File.Delete(file);
            if (Directory.Exists(flow))
                Directory.Delete(flow, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return await RestoreAllAsync(kept) is { } lost
                ? $"Память задачи не снята, и не все её файлы вернулись: {lost}"
                : $"Память задачи не снята: {e.Message}";
        }

        if (tracked.Count == 0)
            return null;
        var commit = await BaseGit.CommitFilesAsync(
            personal, tracked, $"{target.Number ?? target.Memory.Task} откачена из панели: память задачи снята", CancellationToken.None);
        if (commit.Error is not { } refused)
            return null;
        var notBack = await RestoreAllAsync(kept);
        await BaseGit.ResetFilesAsync(personal, tracked, CancellationToken.None);
        return notBack is null
            ? $"Коммит не прошёл — память задачи оставлена: {refused}"
            : $"Коммит не прошёл, и не все файлы памяти вернулись ({notBack}): {refused}";
    }

    private static async Task<string?> RestoreAsync(string file, byte[] bytes)
    {
        try
        {
            await File.WriteAllBytesAsync(file, bytes);
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return e.Message;
        }
    }

    /// <summary>Возвращает файлы как были; null — вернулись все, иначе — какие нет.</summary>
    private static async Task<string?> RestoreAllAsync(IEnumerable<(string File, byte[] Bytes)> kept)
    {
        var lost = new List<string>();
        foreach (var (file, bytes) in kept)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                await File.WriteAllBytesAsync(file, bytes);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                lost.Add(Path.GetFileName(file));
            }
        }
        return lost.Count == 0 ? null : string.Join(", ", lost);
    }
}
