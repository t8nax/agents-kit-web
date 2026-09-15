using System.Text.Json;

namespace AgentsKitWeb.Api.Workspaces;

public static class WorkspaceStatus
{
    public const string Free = "free";
    public const string InWork = "in-work";
    public const string Waiting = "waiting";
}

/// <summary>Строка таблицы рабочих копий. Error задан — данных по строке нет.</summary>
public sealed record WorkspaceRow(
    string Project,
    string Base,
    string Path,
    string? Branch,
    string? Task,
    string? FlowStep,
    int? Progress,
    string? Status,
    string? Error);

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

            foreach (var worktree in worktrees)
            {
                var key = Normalize(worktree.Path);
                if (!claimed.Add(key))
                    continue;
                var path = worktree.Path.Replace('/', '\\');
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
