using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Bases;

/// <summary>
/// Ищет установленный кит там, куда его ставят для Claude Code: в каталоге навыков профиля
/// и среди установленных плагинов. Китом считается только каталог со скриптами проверок —
/// тот же признак, по которому панель принимает путь в настройках.
/// </summary>
public sealed class KitLocator(string claudeDir)
{
    public static string DefaultClaudeDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");

    public IReadOnlyList<string> Find()
    {
        var found = new List<string>();
        foreach (var candidate in Skills().Concat(Plugins()))
        {
            var path = WorkspaceCollector.Normalize(candidate);
            if (Safe(() => BasesStore.IsKit(path)) && !found.Any(f => BasesStore.SamePath(f, path)))
                found.Add(path);
        }
        return found;
    }

    private IEnumerable<string> Skills()
    {
        var skills = Path.Combine(claudeDir, "skills");
        return Safe(() => Directory.Exists(skills)) ? Safe(() => Directory.GetDirectories(skills), []) : [];
    }

    /// <summary>
    /// Кит по сохранённому пути глазами плагинов Claude Code. Плагином кит считается, когда путь — каталог
    /// установки плагина или рядом с ним стоит установка-кит: обновление кладёт новую версию в соседний
    /// каталог, а старую может и удалить, поэтому по наличию старого каталога устаревание не видно.
    /// Новая версия — установка-кит рядом: самая новая, а пока сохранённый путь сам остаётся установкой
    /// (плагин стоит в нескольких областях), — только новее его.
    /// </summary>
    public KitPluginState PluginState(string kit)
    {
        var installs = Plugins().Select(WorkspaceCollector.Normalize).ToList();
        var installed = installs.Any(p => BasesStore.SamePath(p, kit));
        var parent = Path.GetDirectoryName(WorkspaceCollector.Normalize(kit));
        var siblings = installs
            .Where(p => parent is not null && string.Equals(Path.GetDirectoryName(p), parent, StringComparison.OrdinalIgnoreCase))
            .Where(p => !BasesStore.SamePath(p, kit) && Safe(() => BasesStore.IsKit(p)))
            .Select(p => new KitVersion(p, Version(p)))
            .ToList();

        var current = Order(Version(kit));
        var update = siblings
            .Where(s => !installed || Order(s.Version) > current)
            .MaxBy(s => Order(s.Version));
        return new KitPluginState(installed || siblings.Count > 0, update);
    }

    /// <summary>Номер версии для сравнения; не разобран — ниже любого разобранного.</summary>
    private static System.Version Order(string? version) =>
        System.Version.TryParse(version?.Split('-', '+')[0], out var parsed) ? parsed : new System.Version(0, 0);

    /// <summary>Номер версии из описания плагина в каталоге кита; нет описания или номера — null.</summary>
    public static string? Version(string kit)
    {
        try
        {
            using var stream = File.OpenRead(Path.Combine(kit, ".claude-plugin", "plugin.json"));
            using var json = JsonDocument.Parse(stream);
            return json.RootElement.ValueKind == JsonValueKind.Object
                   && json.RootElement.TryGetProperty("version", out var version)
                   && version.ValueKind == JsonValueKind.String
                ? version.GetString()
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Установки плагинов из installed_plugins.json — чужого формата Claude Code; не разобран — плагинов нет.</summary>
    private List<string> Plugins()
    {
        var file = Path.Combine(claudeDir, "plugins", "installed_plugins.json");
        try
        {
            using var stream = File.OpenRead(file);
            using var json = JsonDocument.Parse(stream);
            if (json.RootElement.ValueKind != JsonValueKind.Object
                || !json.RootElement.TryGetProperty("plugins", out var plugins) || plugins.ValueKind != JsonValueKind.Object)
                return [];
            return plugins.EnumerateObject()
                .Where(p => p.Value.ValueKind == JsonValueKind.Array)
                .SelectMany(p => p.Value.EnumerateArray())
                .Select(install => install.ValueKind == JsonValueKind.Object
                                   && install.TryGetProperty("installPath", out var path)
                                   && path.ValueKind == JsonValueKind.String
                    ? path.GetString()
                    : null)
                .OfType<string>()
                .Where(Path.IsPathFullyQualified)
                .ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    private static T Safe<T>(Func<T> read, T fallback = default!)
    {
        try
        {
            return read();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return fallback;
        }
    }
}

/// <summary>Каталог кита и номер его версии; null — номер не прочитан.</summary>
public sealed record KitVersion(string Path, string? Version);

/// <summary>Plugin — кит стоит плагином Claude Code; Update — установленная версия плагина, на которую ещё не перешли.</summary>
public sealed record KitPluginState(bool Plugin, KitVersion? Update);
