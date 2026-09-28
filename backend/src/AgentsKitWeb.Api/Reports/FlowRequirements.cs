using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Reports;

public enum Priority
{
    High,
    Medium,
    Low,
}

/// <summary>Требование к смыслу флоу из справки кита: номер, кольцо — его группа, приоритет, короткое название, формулировка.</summary>
public sealed record Requirement(string Code, string Ring, Priority Priority, string Title, string Text);

/// <summary>
/// Раздел «Требования к флоу» справки кита reference/flow-stages.md: по нему Чудо-Юдо разбирает флоу, а панель считает кольца.
/// Своей копии требований у панели нет — их правят в ките, и копия расходилась бы с ним молча.
/// </summary>
public sealed partial record FlowRequirements(string Section, IReadOnlyList<string> Rings, IReadOnlyList<Requirement> Items)
{
    public const string Heading = "## Требования к флоу";

    // Строка пункта: «- **П1** · высокий · **Каждый исход куда-то ведёт** — формулировка». В названии кит не держит ни тире, ни «·».
    [GeneratedRegex(@"^- \*\*(?<code>[^*]+)\*\* · (?<priority>высокий|средний|низкий) · \*\*(?<title>[^*]+)\*\* — (?<text>.+)$")]
    private static partial Regex ItemLine();

    public Requirement? Find(string code) => Items.FirstOrDefault(item => item.Code == code);

    /// <summary>Требования установленного кита; null — прочитать не вышло, и <paramref name="error"/> называет причину.</summary>
    public static FlowRequirements? Read(string? kitPath, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(kitPath))
        {
            error = "Путь к киту не задан. Его задают в разделе «Настройки».";
            return null;
        }

        string[] lines;
        try
        {
            lines = File.ReadAllLines(FlowRules.File(kitPath));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            error = $"Панель не прочитала справку кита {FlowRules.RulesFile}. Путь к киту задаётся в разделе «Настройки».";
            return null;
        }

        if (FlowRules.Section(lines, Heading) is not { } section)
        {
            error = $"В справке кита {FlowRules.RulesFile} нет раздела «Требования к флоу». Отчёт строится по киту, в котором этот раздел есть.";
            return null;
        }

        var rings = new List<string>();
        var items = new List<Requirement>();
        foreach (var raw in section.Split('\n'))
        {
            var line = raw.TrimEnd();
            if (line.StartsWith("### ", StringComparison.Ordinal))
            {
                rings.Add(line[4..].Trim());
                continue;
            }
            // Пункты стоят только в группах: перечень приоритетов над ними — тоже список, но не требований.
            if (rings.Count == 0 || !line.StartsWith("- ", StringComparison.Ordinal))
                continue;

            var match = ItemLine().Match(line);
            if (!match.Success)
            {
                error = $"В разделе «Требования к флоу» справки кита не разобрана строка: «{line}».";
                return null;
            }
            items.Add(new Requirement(
                match.Groups["code"].Value.Trim(),
                rings[^1],
                match.Groups["priority"].Value switch { "высокий" => Priority.High, "средний" => Priority.Medium, _ => Priority.Low },
                match.Groups["title"].Value.Trim(),
                match.Groups["text"].Value.Trim()));
        }

        if (items.Count == 0)
        {
            error = "В разделе «Требования к флоу» справки кита нет ни одного требования.";
            return null;
        }
        return new FlowRequirements(section, rings.Where(ring => items.Any(item => item.Ring == ring)).ToList(), items);
    }
}
