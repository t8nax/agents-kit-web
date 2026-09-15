using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Bases;

public enum AddBaseProblem
{
    Empty,
    NotFullPath,
    NotABase,
    Duplicate,
}

/// <summary>
/// Список отслеживаемых баз в bases.json панели. Общего реестра баз у кита нет,
/// поэтому список хранит сама панель.
/// </summary>
public sealed class BasesStore(string file)
{
    private readonly Lock _lock = new();

    public static string DefaultFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "agents-kit-web", "bases.json");

    public IReadOnlyList<string> List()
    {
        lock (_lock)
            return Read();
    }

    /// <summary>Добавляет каталог базы; null — добавлен, иначе причина отказа.</summary>
    public AddBaseProblem? Add(string? path, out string added)
    {
        added = "";
        if (string.IsNullOrWhiteSpace(path))
            return AddBaseProblem.Empty;

        var trimmed = path.Trim();
        if (!Path.IsPathFullyQualified(trimmed))
            return AddBaseProblem.NotFullPath;

        var full = WorkspaceCollector.Normalize(Path.GetFullPath(trimmed));
        lock (_lock)
        {
            var bases = Read();
            if (bases.Any(b => SamePath(b, full)))
                return AddBaseProblem.Duplicate;
            // База кита — каталог с agents-kit.json: иначе панель писала бы ответы куда угодно.
            if (!File.Exists(Path.Combine(full, "agents-kit.json")))
                return AddBaseProblem.NotABase;

            Write([.. bases, full]);
        }
        added = full;
        return null;
    }

    public bool Remove(string path)
    {
        lock (_lock)
        {
            var bases = Read();
            var left = bases.Where(b => !SamePath(b, path)).ToList();
            if (left.Count == bases.Count)
                return false;
            Write(left);
            return true;
        }
    }

    public static bool SamePath(string a, string b) =>
        string.Equals(WorkspaceCollector.Normalize(a), WorkspaceCollector.Normalize(b), StringComparison.OrdinalIgnoreCase);

    private List<string> Read()
    {
        if (!File.Exists(file))
            return [];
        using var stream = File.OpenRead(file);
        return JsonSerializer.Deserialize<BasesFile>(stream, JsonOptions)?.Bases ?? [];
    }

    private void Write(List<string> bases)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new BasesFile(bases), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record BasesFile(List<string> Bases);
}
