namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Правила формы стадии для агента — разделы «Стадия» и «Чего во флоу нет» справки кита о флоу и стадиях.
/// Панель их не повторяет своими словами: форму файла правят в ките, и своя копия расходилась бы с ним молча.
/// </summary>
public static class FlowRules
{
    public static readonly string RulesFile = Path.Combine("reference", "flow-stages.md");

    // Первый раздел обязателен: без формы стадии агенту переписывать не по чему.
    private static readonly string[] Headings = ["## Стадия", "## Чего во флоу нет"];

    public static string File(string kitPath) => Path.Combine(kitPath, RulesFile);

    /// <summary>
    /// Разделы правил из справки кита подряд; null — кит не задан, файл не прочитан или раздела «Стадия» в нём больше нет.
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

        var sections = Headings.Select(heading => Section(lines, heading)).ToList();
        return sections[0] is null ? null : string.Join("\n\n", sections.OfType<string>());
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
