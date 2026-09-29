using System.Text.Json.Serialization;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

public static class WorkspaceStatus
{
    public const string Free = "free";

    /// <summary>Панель запустила задачу, а памяти у копии ещё нет: агент только начал (Tasks/StartedTasks).</summary>
    public const string Starting = "starting";
    public const string InWork = "in-work";
    public const string Waiting = "waiting";

    /// <summary>
    /// Оператор ответил, а прочесть ответ некому: ни сессии VS Code, ни фоновой сессии задачи в копии нет
    /// (AgentSessions.Annotate) — решение оператора на B-106.
    /// </summary>
    public const string Unread = "unread";
}

/// <summary>
/// Строка таблицы рабочих копий. Error задан — данных по строке нет. BaseProblems — число находок сверки базы,
/// общее для её копий, Problems — число проблем связи самой копии; оба из последней проверки кита,
/// когда ProblemsState — checked; иначе state называет, почему чисел нет.
/// CopiesDir стоит у копии из списка копий этой машины (local\me.json), от которой панель заводит новые: каталог, куда кит их кладёт.
/// SessionState — что делает сессия агента в копии (значения — SessionState), null — живой сессии в ней нет.
/// BackgroundSession — в копии идёт фоновая сессия агента, и в неё есть переход из терминала.
/// Letters — буквы номеров проекта (Backlog.Letters): по ним фронт отделяет номер задачи от её заголовка.
/// Tracker — имя трекера проекта (Tracker.NameOf): по нему фронт отделяет номер задачи трекера — B-303.
/// VsCodeSession — в копии идёт сессия VS Code: она, как и фоновая сессия задачи, прочтёт ответ оператора.
/// FormatWarning — у всех строк базы нового формата (BaseLayout.NewerFormat): фронт ставит его под заголовком группы.
/// AnswerUnread — в памяти лежит ответ оператора, который сессия ещё не вобрала; наружу не отдаётся,
/// из него AgentSessions.Annotate ставит статус Unread.
/// </summary>
public sealed record WorkspaceRow(
    string Project,
    string Base,
    string Path,
    string? Branch,
    string? Task,
    string? FlowStep,
    int? Progress,
    string? Status,
    string? Error,
    int? Problems = null,
    string? ProblemsState = null,
    string? CopiesDir = null,
    int? BaseProblems = null,
    string? SessionState = null,
    bool BackgroundSession = false,
    string? Letters = null,
    bool VsCodeSession = false,
    [property: JsonIgnore] bool AnswerUnread = false,
    string? FormatWarning = null,
    string? Tracker = null);

public static class WorkspaceCollector
{
    public static async Task<IReadOnlyList<WorkspaceRow>> CollectAsync(
        IEnumerable<string> bases, CancellationToken cancellationToken)
    {
        var rows = new List<WorkspaceRow>();
        foreach (var basePath in bases)
            rows.AddRange(await CollectBaseAsync(basePath, cancellationToken));
        return rows;
    }

    private static async Task<IReadOnlyList<WorkspaceRow>> CollectBaseAsync(
        string basePath, CancellationToken cancellationToken)
    {
        var project = ProjectName.Of(basePath);

        if (!Directory.Exists(basePath))
            return [Unavailable(project, basePath, basePath, "База не найдена на диске")];

        if (BaseLayout.Read(basePath, out var problem) is not { } layout)
            return [Unavailable(project, basePath, basePath, problem)];

        var copies = layout.Workspaces;
        var memories = ReadMemories(layout);
        var letters = Backlog.ReadLetters(layout);
        var tracker = Tracker.NameOf(layout);
        var source = NewCopySource(copies);
        var claimed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var rows = new List<WorkspaceRow>();

        foreach (var copy in copies)
        {
            if (!Directory.Exists(copy))
            {
                claimed.Add(Normalize(copy));
                rows.Add(Unavailable(project, basePath, copy, "Копия не найдена на диске"));
                continue;
            }

            var worktrees = await GitWorktrees.ListAsync(copy, cancellationToken);
            if (worktrees is null)
            {
                claimed.Add(Normalize(copy));
                rows.Add(Unavailable(project, basePath, copy, "git не прочитал копию"));
                continue;
            }

            var segment = ScopeSegment(Normalize(copy), worktrees);

            foreach (var worktree in worktrees)
            {
                var path = segment.Length == 0
                    ? Normalize(worktree.Path)
                    : Path.Combine(Normalize(worktree.Path), segment);
                // Каталог под китом есть не в каждом дереве: на ветке без него копии нет — строки тоже.
                if (segment.Length > 0 && !Directory.Exists(path))
                    continue;

                var key = Normalize(path);
                if (!claimed.Add(key))
                    continue;
                var row = memories.TryGetValue(key, out var memory)
                    ? FromMemory(project, basePath, path, worktree.Branch, memory)
                    : new WorkspaceRow(project, basePath, path, worktree.Branch, null, null, null, WorkspaceStatus.Free, null);
                row = row with { Letters = letters, Tracker = tracker };
                // Кит кладёт новую копию рядом с корнем основного дерева, а git называет основное дерево первым.
                if (source is not null && string.Equals(key, Normalize(source), StringComparison.OrdinalIgnoreCase))
                    row = row with { CopiesDir = Path.GetDirectoryName(Normalize(worktrees[0].Path)) };
                rows.Add(row);
            }
        }

        // Память копии, которой git не назвал, — задача всё равно в работе.
        foreach (var (key, memory) in memories)
        {
            if (claimed.Add(key))
                rows.Add(FromMemory(project, basePath, memory.Copy!, memory.Branch, memory) with { Letters = letters, Tracker = tracker });
        }

        return layout.FormatWarning is { } warning ? rows.Select(r => r with { FormatWarning = warning }).ToList() : rows;
    }

    /// <summary>
    /// Хвост пути копии относительно корня её рабочего дерева: под кит взят каталог
    /// репозитория, а git отдаёт только корни деревьев — в каждом дереве копия живёт
    /// по тому же хвосту. Копия — сам корень: хвоста нет.
    /// </summary>
    private static string ScopeSegment(string copy, IReadOnlyList<Worktree> worktrees)
    {
        var root = worktrees
            .Select(w => Normalize(w.Path))
            .Where(w => copy.StartsWith(w + '\\', StringComparison.OrdinalIgnoreCase))
            .MaxBy(w => w.Length);
        return root is null ? "" : copy[(root.Length + 1)..];
    }

    private static WorkspaceRow FromMemory(string project, string basePath, string path, string? branch, WorkMemory memory) =>
        new(project, basePath, path, branch, memory.Task, memory.FlowStep, memory.Progress,
            memory.WaitingForOperator ? WorkspaceStatus.Waiting : WorkspaceStatus.InWork, null,
            AnswerUnread: memory.AnswerUnread);

    private static WorkspaceRow Unavailable(string project, string basePath, string path, string error) =>
        new(project, basePath, path, null, null, null, null, null, error);

    /// <summary>Копия, от которой заводятся новые: первая из списка копий этой машины, что есть на диске.</summary>
    internal static string? NewCopySource(IEnumerable<string> copies) => copies.FirstOrDefault(Directory.Exists);

    /// <summary>Копии этой машины из local\me.json базы; null — база не читается (BaseLayout).</summary>
    internal static IReadOnlyList<string>? ReadCopies(string basePath) => BaseLayout.Read(basePath)?.Workspaces;

    private static Dictionary<string, WorkMemory> ReadMemories(BaseLayout layout) =>
        MemoryFiles(layout).ToDictionary(e => e.Key, e => e.Value.Memory, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Памяти задач копий этой машины — work\&lt;машина&gt;\*.md личного репозитория — по нормализованному пути копии.
    /// Память других машин оператора — о копиях чужого диска, и ответ в неё панель не пишет. Флоу задачи рядом
    /// с памятью — каталог work\&lt;машина&gt;\&lt;слаг&gt;\flow\ (кит формата 8) — памятью не читается.
    /// </summary>
    internal static Dictionary<string, (string File, WorkMemory Memory)> MemoryFiles(BaseLayout layout)
    {
        var result = new Dictionary<string, (string, WorkMemory)>(StringComparer.OrdinalIgnoreCase);
        foreach (var (file, memory) in ReadMemoryFiles(layout.MemoryDir))
            // Копия памяти — полным путём, как её приводит кит: «a\..\b» в памяти — та же копия, что «b» в списке.
            result.TryAdd(FullPath(memory.Copy!), (file, memory));
        return result;
    }

    /// <summary>
    /// Памяти задач всех машин оператора, какие приехали в его личный репозиторий, — work\&lt;машина&gt;\*.md: одинаковый
    /// путь копии на двух машинах — две задачи, поэтому по копии они не схлопываются. Флоу задачи рядом с памятью
    /// (кит формата 8) памятью не читается.
    /// </summary>
    internal static IEnumerable<(string File, WorkMemory Memory)> AllMemories(BaseLayout layout) =>
        Directory.Exists(layout.WorkDir)
            ? Directory.EnumerateDirectories(layout.WorkDir).SelectMany(ReadMemoryFiles)
            : [];

    private static IEnumerable<(string File, WorkMemory Memory)> ReadMemoryFiles(string memoryDir)
    {
        if (!Directory.Exists(memoryDir))
            yield break;

        foreach (var file in Directory.EnumerateFiles(memoryDir, "*.md", SearchOption.TopDirectoryOnly))
        {
            WorkMemory memory;
            try
            {
                memory = WorkMemory.Parse(File.ReadAllText(file));
            }
            catch (IOException)
            {
                continue;
            }
            if (!string.IsNullOrWhiteSpace(memory.Copy))
                yield return (file, memory);
        }
    }

    internal static string Normalize(string path) =>
        path.Replace('/', '\\').TrimEnd('\\');

    /// <summary>Путь копии, как его приводит кит (ConvertTo-KitPath): полный, без «..» и хвостового «\».</summary>
    internal static string FullPath(string path)
    {
        try
        {
            return Normalize(Path.GetFullPath(path));
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return Normalize(path);
        }
    }
}
