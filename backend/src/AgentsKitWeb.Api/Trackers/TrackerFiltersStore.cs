using System.Text.Json;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>Файл фильтров задач трекеров не разобран: его не читают как пустой и не перезаписывают.</summary>
public sealed class FiltersFileBroken(string file) : Exception($"Файл фильтров задач трекеров не разобран: {file}")
{
    public string File { get; } = file;
}

/// <summary>
/// Фильтры задач трекеров по проектам — строка поиска самого трекера, которую панель дописывает к своему запросу
/// незакрытых задач проекта. Хранятся в панели на этом компьютере, а не в описании трекера в базе: оператор задаёт
/// их на вкладке «Задачи трекера» раздела «Бэклог», и они применяются сразу, без коммита и отдачи базы — ответы
/// оператора на B-285. Раньше, с B-300, фильтр был строкой «фильтр:» описания трекера: пока для проекта в панели
/// ничего не задано, действует она, а при записи описания она переезжает сюда.
/// </summary>
public sealed class TrackerFiltersStore(string file)
{
    private readonly Lock _lock = new();

    /// <summary>Место по умолчанию — локальный профиль, рядом с ключами к серверам трекеров.</summary>
    public static string DefaultFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "agents-kit-web", "filters.json");

    /// <summary>Рядом со своим списком баз — у песочницы и тестов: фильтры оператора им не видны.</summary>
    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "filters.json");

    /// <summary>
    /// Фильтр проекта: заданный в панели, а не задан — described, строка «фильтр:» описания трекера. Пустой заданный —
    /// отбора нет, null. Файл битый — действует described: показать задачи важнее, чем отказать из-за отбора.
    /// </summary>
    public string? Of(string basePath, string? described)
    {
        Dictionary<string, string>? filters;
        lock (_lock)
            try
            {
                filters = Read();
            }
            catch (FiltersFileBroken)
            {
                filters = null;
            }
        var entry = filters?.FirstOrDefault(f => BasesStore.SamePath(f.Key, basePath));
        var filter = entry is { Key: not null } found ? found.Value : described;
        return string.IsNullOrWhiteSpace(filter) ? null : filter.Trim();
    }

    /// <summary>Задаёт фильтр проекта; пустой — отбора нет, и строка «фильтр:» описания больше не действует.</summary>
    public void Set(string basePath, string? filter)
    {
        lock (_lock)
        {
            var filters = Read();
            var known = filters.Keys.FirstOrDefault(k => BasesStore.SamePath(k, basePath));
            filters[known ?? basePath] = (filter ?? "").Trim();
            Write(filters);
        }
    }

    /// <summary>
    /// Снимает фильтр проекта совсем: трекер удалён или сменил вид, и строка поиска прежнего трекера новому не годится
    /// (ревью B-285). Строки «фильтр:» в описании к этому времени уже нет — её убирает запись описания.
    /// </summary>
    public void Remove(string basePath)
    {
        lock (_lock)
        {
            var filters = Read();
            var known = filters.Keys.FirstOrDefault(k => BasesStore.SamePath(k, basePath));
            if (known is null)
                return;
            filters.Remove(known);
            Write(filters);
        }
    }

    /// <summary>Переезд строки «фильтр:» описания: задаёт её фильтром проекта, только если в панели он ещё не задан.</summary>
    public void Keep(string basePath, string? described)
    {
        if (string.IsNullOrWhiteSpace(described))
            return;
        lock (_lock)
        {
            var filters = Read();
            if (filters.Keys.Any(k => BasesStore.SamePath(k, basePath)))
                return;
            filters[basePath] = described.Trim();
            Write(filters);
        }
    }

    private Dictionary<string, string> Read()
    {
        if (!System.IO.File.Exists(file))
            return [];
        try
        {
            using var stream = System.IO.File.OpenRead(file);
            return JsonSerializer.Deserialize<StoredFile>(stream, JsonOptions)?.Filters is { } stored
                ? new Dictionary<string, string>(stored)
                : throw new FiltersFileBroken(file);
        }
        catch (JsonException)
        {
            throw new FiltersFileBroken(file);
        }
    }

    private void Write(Dictionary<string, string> filters)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        System.IO.File.WriteAllText(temp, JsonSerializer.Serialize(new StoredFile(filters), JsonOptions));
        System.IO.File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record StoredFile(Dictionary<string, string> Filters);
}
