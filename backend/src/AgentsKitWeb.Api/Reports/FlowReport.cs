using System.Text.Json.Serialization;

namespace AgentsKitWeb.Api.Reports;

/// <summary>Место во флоу и что там написано.</summary>
public sealed record ReportQuote(string Where, string Text);

/// <summary>
/// Находка разбора: одно место во флоу, нарушающее одно или несколько требований. Под двумя требованиями она снимает баллы
/// в обоих кольцах и показывается строкой в каждом — решение оператора на B-270.
/// </summary>
public sealed record ReportFinding(
    string Id,
    IReadOnlyList<string> Requirements,
    string Place,
    IReadOnlyList<ReportQuote> Quotes,
    string Why,
    string Fix);

/// <summary>Вопрос устройства без ошибки: выбор, а не проблема, — баллов не снимает.</summary>
public sealed record ReportDiscussion(string Title, string Place, string Now, string For, string Against);

/// <summary>
/// Отчёт о флоу проекта. Требования хранятся такими, какими были при разборе: отчёт показывается и тогда, когда кит уже другой.
/// <paramref name="Checked"/> — когда флоу проверяли в последний раз: запуск по расписанию без изменений флоу отчёт не строит, а только
/// сдвигает эту отметку. <paramref name="Fingerprint"/> — отпечаток флоу и субагентов, по которому это видно.
/// </summary>
public sealed record FlowReport(
    DateTimeOffset Built,
    DateTimeOffset Checked,
    string Fingerprint,
    IReadOnlyList<Requirement> Requirements,
    IReadOnlyList<ReportFinding> Findings,
    IReadOnlyList<ReportDiscussion> Discussions);

/// <summary>Расписание отчёта проекта: дни недели и час по часам машины. По умолчанию выключено — решение оператора на B-270.</summary>
public sealed record ReportSchedule(bool Enabled, IReadOnlyList<DayOfWeek> Days, int Hour)
{
    public static readonly ReportSchedule Off = new(false, [], 9);

    /// <summary>Расписание, годное к записи: час в пределах суток, дни без повторов по порядку недели от понедельника.</summary>
    [JsonIgnore]
    public bool IsValid => Hour is >= 0 and <= 23 && Days.All(Enum.IsDefined);

    public ReportSchedule Normalized() =>
        this with { Days = Days.Distinct().OrderBy(day => ((int)day + 6) % 7).ToList() };
}
