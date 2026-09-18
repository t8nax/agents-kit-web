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

    /// <summary>Профиль Claude Code оператора: в нём же лежат его собственные субагенты.</summary>
    public string ClaudeDir => claudeDir;

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

    /// <summary>Каталоги плагинов из installed_plugins.json — чужого формата Claude Code; не разобран — плагинов нет.</summary>
    private IEnumerable<string> Plugins()
    {
        var file = Path.Combine(claudeDir, "plugins", "installed_plugins.json");
        try
        {
            using var stream = File.OpenRead(file);
            using var json = JsonDocument.Parse(stream);
            if (!json.RootElement.TryGetProperty("plugins", out var plugins) || plugins.ValueKind != JsonValueKind.Object)
                return [];
            return plugins.EnumerateObject()
                .Where(p => p.Value.ValueKind == JsonValueKind.Array)
                .SelectMany(p => p.Value.EnumerateArray())
                .Select(install => install.ValueKind == JsonValueKind.Object && install.TryGetProperty("installPath", out var path)
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
