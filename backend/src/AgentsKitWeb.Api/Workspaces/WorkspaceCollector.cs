using System.Text.Json;

namespace AgentsKitWeb.Api.Workspaces;

public static class WorkspaceStatus
{
    public const string Free = "free";
    public const string InWork = "in-work";
    public const string Waiting = "waiting";
}

/// <summary>
/// Строка таблицы рабочих копий. Error задан — данных по строке нет. Problems — число проблем копии
/// и её базы из последней проверки кита, когда ProblemsState — checked; иначе state называет, почему числа нет.
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
    string? ProblemsState = null);

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

        var copies = ReadCopies(basePath);
        if (copies is null)
            return [Unavailable(project, basePath, basePath, "Не прочитан agents-kit.json базы")];

        var memories = ReadMemories(basePath);
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
                rows.Add(memories.TryGetValue(key, out var memory)
                    ? FromMemory(project, basePath, path, worktree.Branch, memory)
                    : new WorkspaceRow(project, basePath, path, worktree.Branch, null, null, null, WorkspaceStatus.Free, null));
            }
        }

        // Память копии, которой git не назвал, — задача всё равно в работе.
        foreach (var (key, memory) in memories)
        {
            if (claimed.Add(key))
                rows.Add(FromMemory(project, basePath, memory.Copy!, memory.Branch, memory));
        }

        return rows;
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
            memory.WaitingForOperator ? WorkspaceStatus.Waiting : WorkspaceStatus.InWork, null);

    private static WorkspaceRow Unavailable(string project, string basePath, string path, string error) =>
        new(project, basePath, path, null, null, null, null, null, error);

    private static List<string>? ReadCopies(string basePath)
    {
        try
        {
            using var stream = File.OpenRead(Path.Combine(basePath, "agents-kit.json"));
            using var json = JsonDocument.Parse(stream);
            return json.RootElement.GetProperty("workspaces")
                .EnumerateArray()
                .Select(e => e.GetString())
                .OfType<string>()
                .ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException
                                      or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }

    private static Dictionary<string, WorkMemory> ReadMemories(string basePath) =>
        MemoryFiles(basePath).ToDictionary(e => e.Key, e => e.Value.Memory, StringComparer.OrdinalIgnoreCase);

    /// <summary>Памяти work/*.md базы по нормализованному пути копии.</summary>
    internal static Dictionary<string, (string File, WorkMemory Memory)> MemoryFiles(string basePath)
    {
        var result = new Dictionary<string, (string, WorkMemory)>(StringComparer.OrdinalIgnoreCase);
        var workDir = Path.Combine(basePath, "work");
        if (!Directory.Exists(workDir))
            return result;

        foreach (var file in Directory.EnumerateFiles(workDir, "*.md"))
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
                result.TryAdd(Normalize(memory.Copy), (file, memory));
        }
        return result;
    }

    internal static string Normalize(string path) =>
        path.Replace('/', '\\').TrimEnd('\\');
}
