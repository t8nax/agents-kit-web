namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Правила формы этапа для агента — разделы «Этап» и «Чего во флоу нет» справки кита о флоу.
/// Панель их не повторяет своими словами: форму файла правят в ките, и своя копия расходилась бы с ним молча.
/// </summary>
public static class FlowRules
{
    public static readonly string RulesFile = Path.Combine("reference", "flow-stages.md");

    // Первый раздел обязателен: без формы этапа агенту переписывать не по чему. Кит прежнего вида звал его «Стадия».
    private static readonly string[] FormHeadings = ["## Этап", "## Стадия"];
    private const string LimitsHeading = "## Чего во флоу нет";

    public static string File(string kitPath) => Path.Combine(kitPath, RulesFile);

    /// <summary>
    /// Разделы правил из справки кита подряд; null — кит не задан, файл не прочитан или раздела о форме этапа в нём нет.
    /// </summary>
    public static string? Read(string? kitPath)
    {
        if (string.IsNullOrWhiteSpace(kitPath))
            return null;

        string[] lines;
        try
        {
            lines = System.IO.File.ReadAllLines(File(kitPath));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var form = FormHeadings.Select(heading => Section(lines, heading)).FirstOrDefault(section => section is not null);
        return form is null ? null : string.Join("\n\n", new[] { form, Section(lines, LimitsHeading) }.OfType<string>());
    }

    private static string? Section(string[] lines, string heading)
    {
        var start = Array.FindIndex(lines, line => line.TrimEnd() == heading);
        if (start < 0)
            return null;

        // Раздел идёт до следующего заголовка того же уровня; «###» внутри — его часть.
        var end = Array.FindIndex(lines, start + 1, line => line.StartsWith("## ", StringComparison.Ordinal));
        var text = string.Join("\n", lines[start..(end < 0 ? lines.Length : end)]).TrimEnd();
        return text.Length > heading.Length ? text : null;
    }
}
