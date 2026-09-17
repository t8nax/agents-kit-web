using System.Text.Json;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Значки шагов флоу в flow-icons.json профиля оператора, рядом с bases.json: в файле флоу базы значку
/// места нет — форму файла задаёт кит, — поэтому выбор помнит сама панель. Ключ значка — база и название шага.
/// </summary>
public sealed class FlowIconsStore(string file)
{
    private readonly Lock _lock = new();

    /// <summary>Значки, которые панель умеет рисовать; чужой значок не записывается.</summary>
    public static readonly string[] Known = ["target", "branch", "code", "check", "base"];

    /// <summary>flow-icons.json в каталоге файла настроек: прогон, задавший свой BasesFile, не тронет профиль.</summary>
    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "flow-icons.json");

    /// <summary>Значки шагов базы: название шага — значок. Значков нет — пустой словарь.</summary>
    public IReadOnlyDictionary<string, string> Of(string basePath)
    {
        lock (_lock)
            return Read().FirstOrDefault(pair => BasesStore.SamePath(pair.Key, basePath)).Value ?? [];
    }

    /// <summary>Заменяет значки базы целиком: шаг ушёл из флоу — уходит и его значок.</summary>
    public void Save(string basePath, IReadOnlyDictionary<string, string>? icons)
    {
        var kept = (icons ?? new Dictionary<string, string>())
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Key) && Known.Contains(pair.Value))
            .ToDictionary(pair => pair.Key.Trim(), pair => pair.Value);

        lock (_lock)
        {
            var all = Read().Where(pair => !BasesStore.SamePath(pair.Key, basePath)).ToDictionary();
            if (kept.Count > 0)
                all[basePath] = kept;
            Write(all);
        }
    }

    private Dictionary<string, Dictionary<string, string>> Read()
    {
        if (!File.Exists(file))
            return [];
        using var stream = File.OpenRead(file);
        return JsonSerializer.Deserialize<IconsFile>(stream, JsonOptions)?.Icons ?? [];
    }

    private void Write(Dictionary<string, Dictionary<string, string>> icons)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new IconsFile(icons), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record IconsFile(Dictionary<string, Dictionary<string, string>> Icons);
}
