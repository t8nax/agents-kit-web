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
/// в бэклог. Dirty — в копии есть несохранённые правки, и откат их сотрёт. Blockers — сессии копии, которые панель
/// погасить не может: пока они живы, откат отказывает.
/// </summary>
public sealed record RollbackPlan(string Task, string Source, bool Dirty, IReadOnlyList<RollbackBlocker> Blockers);

/// <summary>Сессия, которая мешает откату: Kind — vscode или terminal, Name — имя сессии, если оно есть.</summary>
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
/// все шаги снова, поэтому каждый шаг, уже сделанный, проходит молча. Память задачи снимается последней: пока она
/// есть, копия числится занятой, и откат можно повторить из того же меню.
/// </summary>
public static class TaskRollback
{
    public const string Session = "session";
    public const string Backlog = "backlog";
    public const string Copy = "copy";
    public const string Memory = "memory";

    public static readonly IReadOnlyList<string> Steps = [Session, Backlog, Copy, Memory];

    // Сброс копии и коммит базы могут идти долго на большой копии или с хуком сверки кита.
    private static readonly TimeSpan GitTimeout = TimeSpan.FromSeconds(60);

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
            return Results.Ok(new RollbackPlan(
                target.Memory.Task ?? "",
                target.Source,
                status.ExitCode != 0 || status.Output.Length > 0,
                Blockers(sessions, target.Row.Path)));
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
            // Сессию своего окна панель не гасит: её закрывает оператор, и до того копию не трогают.
            if (Blockers(sessions, target.Row.Path) is [_, ..] blockers)
                return Results.Conflict(new RollbackProblem("blocked", string.Join(", ", blockers.Select(b => b.Kind))));

            // Начавшись, шаг отменой запроса не рвётся: оборванный git оставил бы базу или копию на полпути.
            var failure = step switch
            {
                Session => await StopSessionsAsync(target, sessions, taskSessions, started, agent),
                Backlog => await ReturnEntryAsync(target),
                Copy => await ResetCopyAsync(target),
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

    /// <summary>Сессии копии, которые панель погасить не может: всё, кроме фоновых.</summary>
    private static List<RollbackBlocker> Blockers(AgentSessions sessions, string copy) =>
        sessions.LiveIn(copy)
            .Where(s => !s.InBackground)
            .Select(s => new RollbackBlocker(s.InVsCode ? "vscode" : "terminal", s.Name))
            .ToList();

    /// <summary>
    /// Гасит фоновые сессии копии — сессию задачи и заведённые рядом с ней: они правили бы копию, которую откат
    /// сейчас вернёт. Панель забывает свой запуск задачи в копии: иначе копия числилась бы запускаемой.
    /// </summary>
    private static async Task<string?> StopSessionsAsync(
        Target target, AgentSessions sessions, TaskSessions taskSessions, StartedTasks started, IAgentProcess agent)
    {
        foreach (var session in sessions.LiveIn(target.Row.Path).Where(s => s.InBackground).ToList())
            if (await SessionStop.StopAsync(agent, session, CancellationToken.None) is { } failure)
                return $"Сессия {session.Name ?? session.JobId} не погасла: {failure}";
        started.Forget(target.Row.Path);
        taskSessions.Forget(target.Row.Path);
        return null;
    }

    /// <summary>
    /// Возвращает запись бэклога тем же номером и тем же текстом, какой она была, когда её взяли, — в конец
    /// backlog.md; счётчик номеров не трогается. Текст берётся из истории: из родителя коммита, который её вырезал.
    /// Запись уже в бэклоге — шаг сделан прошлым откатом.
    /// </summary>
    private static async Task<string?> ReturnEntryAsync(Target target)
    {
        if (target.Source != RollbackSource.Backlog || target.Number is not { } number)
            return null;

        var personal = target.Layout.Personal;
        var file = target.Layout.BacklogFile;
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

    /// <summary>Запись в конце файла, через пустую строку, с переводами строк, какие у файла.</summary>
    internal static string Appended(string text, string entry)
    {
        var newline = text.Contains("\r\n") ? "\r\n" : "\n";
        var body = text.TrimEnd('\r', '\n');
        var separator = body.Length == 0 ? "" : newline + newline;
        return body + separator + entry.Replace("\n", newline) + newline;
    }

    /// <summary>
    /// Возвращает копию на ветку, на которой она стояла до задачи, и стирает несохранённые правки; ветка задачи
    /// удаляется на компьютере, а на GitHub остаётся — решение оператора на макете B-108. Прежняя ветка копии —
    /// имя её каталога, как его заводит кит (worktree-add.ps1), у основной копии — master.
    /// </summary>
    private static async Task<string?> ResetCopyAsync(Target target)
    {
        var copy = WorkspaceCollector.Normalize(target.Row.Path);
        if (await GitWorktrees.ListAsync(copy, CancellationToken.None) is not [var main, ..] worktrees)
            return "git не прочитал копию";
        var worktree = worktrees
            .Where(w => copy.Equals(WorkspaceCollector.Normalize(w.Path), StringComparison.OrdinalIgnoreCase)
                || copy.StartsWith(WorkspaceCollector.Normalize(w.Path) + '\\', StringComparison.OrdinalIgnoreCase))
            .MaxBy(w => w.Path.Length);
        if (worktree is null)
            return "git не назвал дерево копии";

        var root = WorkspaceCollector.Normalize(worktree.Path);
        var previous = root.Equals(WorkspaceCollector.Normalize(main.Path), StringComparison.OrdinalIgnoreCase)
            ? "master"
            : Path.GetFileName(root);
        var task = target.Memory.Branch is { Length: > 0 } branch && branch != "отсоединён" ? branch : worktree.Branch;

        // Неотслеживаемые файлы — тоже несохранённые правки; игнорируемые (субагенты кита, сборки) остаются.
        if (await GitAsync(root, "reset", "--hard", "-q") is { } notReset)
            return $"Несохранённые правки не стёрлись: {notReset}";
        if (await GitAsync(root, "clean", "-fdq") is { } notCleaned)
            return $"Новые файлы не стёрлись: {notCleaned}";
        if (worktree.Branch != previous && await GitAsync(root, "checkout", "-q", previous) is { } notSwitched)
            return $"Копия не перешла на ветку {previous}: {notSwitched}";

        // Общие ветки проекта откат не удаляет, даже если задача шла прямо в них.
        if (task == previous || task is "master" or "dev" or "отсоединён")
            return null;
        var exists = await GitRunner.RunAsync(root, GitTimeout, CancellationToken.None, "rev-parse", "--verify", "-q", $"refs/heads/{task}");
        if (exists.ExitCode != 0)
            return null;
        return await GitAsync(root, "branch", "-D", task) is { } notDeleted
            ? $"Ветка задачи {task} не удалилась: {notDeleted}"
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
            await RestoreAllAsync(kept);
            return $"Память задачи не снята: {e.Message}";
        }

        if (tracked.Count == 0)
            return null;
        var commit = await BaseGit.CommitFilesAsync(
            personal, tracked, $"{target.Number ?? target.Memory.Task} откачена из панели: память задачи снята", CancellationToken.None);
        if (commit.Error is not { } refused)
            return null;
        await RestoreAllAsync(kept);
        await BaseGit.ResetFilesAsync(personal, tracked, CancellationToken.None);
        return $"Коммит не прошёл — память задачи оставлена: {refused}";
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

    private static async Task RestoreAllAsync(IEnumerable<(string File, byte[] Bytes)> kept)
    {
        foreach (var (file, bytes) in kept)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                await File.WriteAllBytesAsync(file, bytes);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Не вернувшийся файл назовёт сверка кита: git знает, каким он был.
            }
        }
    }
}
