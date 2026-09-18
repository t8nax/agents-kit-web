namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Правила формы флоу для агента — раздел «Флоу проекта» раскладки базы установленного кита.
/// Панель их не повторяет своими словами: форму файла правят в ките, и своя копия расходилась бы с ним молча.
/// </summary>
public static class FlowRules
{
    public static readonly string LayoutFile = Path.Combine("reference", "base-layout.md");

    private const string Heading = "## Флоу проекта";

    public static string File(string kitPath) => Path.Combine(kitPath, LayoutFile);

    /// <summary>
    /// Раздел правил из раскладки кита; null — кит не задан, файл не прочитан или раздела в нём больше нет.
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

        var start = Array.FindIndex(lines, line => line.TrimEnd() == Heading);
        if (start < 0)
            return null;

        // Раздел идёт до следующего заголовка того же уровня; «### Шаг» внутри — его часть.
        var end = Array.FindIndex(lines, start + 1, line => line.StartsWith("## ", StringComparison.Ordinal));
        var section = lines[start..(end < 0 ? lines.Length : end)];
        var text = string.Join("\n", section).TrimEnd();
        return text.Length > Heading.Length ? text : null;
    }
}
