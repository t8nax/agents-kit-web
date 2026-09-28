using System.Text.Json;
using System.Text.Json.Serialization;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Reports;

/// <summary>Что панель помнит об отчёте одного вида по одному проекту.</summary>
/// <param name="ScheduledAt">Последнее назначенное расписанием время, которое панель уже отработала — запуском или пропуском.</param>
public sealed record ReportEntry(ReportSchedule Schedule, FlowReport? Report, DateTimeOffset? ScheduledAt)
{
    public static readonly ReportEntry Empty = new(ReportSchedule.Off, null, null);
}

/// <summary>
/// Отчёты и их расписания в reports.json профиля оператора, рядом с bases.json: отчёты нужны только оператору и в базе им
/// делать нечего — решение оператора на B-270. Ключ — база и вид отчёта: вид сейчас один, «flow», но раздел ждёт и другие.
/// Хранится только последний отчёт: сравнения с прошлым и истории нет — сужение оператора на B-270.
/// </summary>
public sealed class ReportsStore(string file)
{
    public const string FlowKind = "flow";

    private readonly Lock _lock = new();

    /// <summary>reports.json в каталоге файла настроек: прогон, задавший свой BasesFile, не тронет профиль.</summary>
    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "reports.json");

    public ReportEntry Of(string basePath, string kind)
    {
        lock (_lock)
            return Find(Read(), basePath, kind)?.Entry ?? ReportEntry.Empty;
    }

    /// <summary>Все записи — для расписания.</summary>
    public IReadOnlyList<(string Base, string Kind, ReportEntry Entry)> All()
    {
        lock (_lock)
            return Read().Select(item => (item.Base, item.Kind, item.Entry)).ToList();
    }

    public void SaveSchedule(string basePath, string kind, ReportSchedule schedule) =>
        Change(basePath, kind, entry => entry with { Schedule = schedule.Normalized() });

    public void SaveReport(string basePath, string kind, FlowReport report) =>
        Change(basePath, kind, entry => entry with { Report = report });

    /// <summary>Флоу проверен и не менялся: отчёт прежний, сдвигается только отметка проверки.</summary>
    public void MarkChecked(string basePath, string kind, DateTimeOffset at) =>
        Change(basePath, kind, entry => entry.Report is null ? entry : entry with { Report = entry.Report with { Checked = at } });

    public void MarkScheduled(string basePath, string kind, DateTimeOffset due) =>
        Change(basePath, kind, entry => entry with { ScheduledAt = due });

    private void Change(string basePath, string kind, Func<ReportEntry, ReportEntry> change)
    {
        lock (_lock)
        {
            var all = Read();
            var item = Find(all, basePath, kind);
            var entry = change(item?.Entry ?? ReportEntry.Empty);
            if (item is null)
                all.Add(new StoredEntry(basePath, kind, entry));
            else
                all[all.IndexOf(item)] = item with { Entry = entry };
            Write(all);
        }
    }

    private static StoredEntry? Find(List<StoredEntry> all, string basePath, string kind) =>
        all.FirstOrDefault(item => item.Kind == kind && BasesStore.SamePath(item.Base, basePath));

    private List<StoredEntry> Read()
    {
        if (!File.Exists(file))
            return [];
        try
        {
            using var stream = File.OpenRead(file);
            return JsonSerializer.Deserialize<ReportsFile>(stream, JsonOptions)?.Reports.ToList() ?? [];
        }
        catch (JsonException)
        {
            // Испорченный файл не должен ронять раздел: отчёты строятся заново, а расписание задаётся ещё раз.
            return [];
        }
    }

    private void Write(List<StoredEntry> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new ReportsFile(all), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private sealed record StoredEntry(string Base, string Kind, ReportEntry Entry);

    private sealed record ReportsFile(IReadOnlyList<StoredEntry> Reports);
}
