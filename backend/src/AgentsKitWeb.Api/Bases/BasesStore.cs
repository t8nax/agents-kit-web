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

public enum SetKitProblem
{
    Empty,
    NotFullPath,
    NotAKit,
}

/// <summary>
/// Настройки панели в bases.json: список отслеживаемых баз и путь к установленному киту.
/// Общего реестра баз у кита нет, а где стоит кит, панель ниоткуда не узнаёт, — поэтому
/// и то и другое хранит сама панель.
/// </summary>
public sealed class BasesStore(string file)
{
    private readonly Lock _lock = new();

    public static string DefaultFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "agents-kit-web", "bases.json");

    /// <summary>Скрипты кита, которыми панель проверяет базы; каталог без них — не кит.</summary>
    public static readonly string[] KitScripts = ["scripts\\base-check.ps1", "scripts\\link-state.ps1"];

    /// <summary>Список баз или путь к киту поменялся.</summary>
    public event Action? Changed;

    public IReadOnlyList<string> List()
    {
        lock (_lock)
            return Read().Bases;
    }

    /// <summary>Путь к киту; null — не задан.</summary>
    public string? Kit()
    {
        lock (_lock)
            return Read().Kit;
    }

    public static bool IsKit(string path) =>
        KitScripts.All(script => File.Exists(Path.Combine(path, script)));

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
            var settings = Read();
            if (settings.Bases.Any(b => SamePath(b, full)))
                return AddBaseProblem.Duplicate;
            // База кита — каталог с agents-kit.json: иначе панель писала бы ответы куда угодно.
            if (!File.Exists(Path.Combine(full, "agents-kit.json")))
                return AddBaseProblem.NotABase;

            Write(settings with { Bases = [.. settings.Bases, full] });
        }
        added = full;
        Changed?.Invoke();
        return null;
    }

    public bool Remove(string path)
    {
        lock (_lock)
        {
            var settings = Read();
            var left = settings.Bases.Where(b => !SamePath(b, path)).ToList();
            if (left.Count == settings.Bases.Count)
                return false;
            Write(settings with { Bases = left });
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Задаёт путь к киту; null — сохранён, иначе причина отказа.</summary>
    public SetKitProblem? SetKit(string? path, out string saved)
    {
        saved = "";
        if (string.IsNullOrWhiteSpace(path))
            return SetKitProblem.Empty;

        var trimmed = path.Trim();
        if (!Path.IsPathFullyQualified(trimmed))
            return SetKitProblem.NotFullPath;

        var full = WorkspaceCollector.Normalize(Path.GetFullPath(trimmed));
        // Панель запускает скрипты по этому пути: чужой каталог сохранять нельзя.
        if (!IsKit(full))
            return SetKitProblem.NotAKit;

        lock (_lock)
            Write(Read() with { Kit = full });
        saved = full;
        Changed?.Invoke();
        return null;
    }

    public static bool SamePath(string a, string b) =>
        string.Equals(WorkspaceCollector.Normalize(a), WorkspaceCollector.Normalize(b), StringComparison.OrdinalIgnoreCase);

    private SettingsFile Read()
    {
        if (!File.Exists(file))
            return new SettingsFile([], null);
        using var stream = File.OpenRead(file);
        var settings = JsonSerializer.Deserialize<SettingsFile>(stream, JsonOptions);
        return new SettingsFile(settings?.Bases ?? [], settings?.Kit);
    }

    private void Write(SettingsFile settings)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed record SettingsFile(List<string> Bases, string? Kit);
}
