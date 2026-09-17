using System.Text;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Шаг флоу проекта. Description — описание шага как в файле: абзацы, списки и пункты «N.1.»; панель его не показывает,
/// а переносит при записи, меняя в пунктах номер шага.
/// </summary>
public sealed record FlowStep(string Title, string Executor, string Output, string? Skip, string? Description);

/// <summary>Файл флоу: шапка до первого шага — как в файле, с HTML-комментарием, — и шаги по порядку.</summary>
public sealed record FlowDocument(string Header, IReadOnlyList<FlowStep> Steps);

public enum FlowProblem
{
    EmptyTitle,
    EmptyExecutor,
    EmptyOutput,
    /// <summary>В однострочном поле перевод строки: ключ шага в файле — одна строка.</summary>
    LineBreak,
}

/// <summary>Почему флоу не записан; Step — номер шага с единицы.</summary>
public sealed record FlowRejection(int Step, FlowProblem Problem);

/// <summary>Разбор и запись flow.md базы в форме шага кита (раздел «Флоу проекта» раскладки базы).</summary>
public static partial class FlowFile
{
    public const string FileName = "flow.md";

    // «## 3. Реализация» → «Реализация». Раздел «##» без номера тоже шаг: номер ставит запись.
    [GeneratedRegex(@"^##\s+(?:\d+\.\s*)?(?<title>.*)$")]
    private static partial Regex StepHeading { get; }

    // Ключи шага — закрытый перечень кита.
    [GeneratedRegex(@"^(?<key>исполнитель|выход|пропуск):\s*(?<value>.*)$")]
    private static partial Regex KeyLine { get; }

    // Номер пункта описания: «3.2.1.» → номер шага «3» и хвост «.2.1.».
    [GeneratedRegex(@"^(?<indent>[ \t]*)\d+(?<rest>(?:\.\d+)+\.)", RegexOptions.Multiline)]
    private static partial Regex PointNumber { get; }

    public static FlowDocument Parse(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var header = new List<string>();
        var steps = new List<FlowStep>();
        var i = 0;

        while (i < lines.Length && !lines[i].StartsWith("## "))
            header.Add(lines[i++]);

        while (i < lines.Length)
        {
            var title = StepHeading.Match(lines[i++]).Groups["title"].Value.Trim();
            var keys = new Dictionary<string, string>();

            // Ключи идут подряд под заголовком; пустые строки перед ними пропускаются.
            while (i < lines.Length && lines[i].Trim().Length == 0)
                i++;
            while (i < lines.Length && KeyLine.Match(lines[i]) is { Success: true } key)
            {
                keys.TryAdd(key.Groups["key"].Value, key.Groups["value"].Value.Trim());
                i++;
            }

            var description = new List<string>();
            while (i < lines.Length && !lines[i].StartsWith("## "))
                description.Add(lines[i++]);

            steps.Add(new FlowStep(
                title,
                keys.GetValueOrDefault("исполнитель", ""),
                keys.GetValueOrDefault("выход", ""),
                keys.TryGetValue("пропуск", out var skip) && skip.Length > 0 ? skip : null,
                Block(description)));
        }

        return new FlowDocument(Block(header) ?? "", steps);
    }

    /// <summary>Текст файла: шаги нумеруются подряд с единицы, пункты описания — вслед за номером шага.</summary>
    public static string Serialize(FlowDocument document, string eol = "\n")
    {
        var parts = new List<string>();
        if (document.Header.Length > 0)
            parts.Add(document.Header);

        for (var index = 0; index < document.Steps.Count; index++)
        {
            var step = document.Steps[index];
            var number = index + 1;
            var block = new StringBuilder();
            block.Append($"## {number}. {step.Title.Trim()}\n\n");
            block.Append($"исполнитель: {step.Executor.Trim()}\n");
            block.Append($"выход: {step.Output.Trim()}");
            if (!string.IsNullOrWhiteSpace(step.Skip))
                block.Append($"\nпропуск: {step.Skip.Trim()}");
            if (Block(step.Description?.Replace("\r\n", "\n").Split('\n') ?? []) is { } description)
                block.Append("\n\n").Append(Renumber(description, number));
            parts.Add(block.ToString());
        }

        return (string.Join("\n\n", parts) + "\n").Replace("\n", eol);
    }

    public static string Renumber(string description, int number) =>
        PointNumber.Replace(description, m => $"{m.Groups["indent"].Value}{number}{m.Groups["rest"].Value}");

    /// <summary>Первый шаг, который в файл в форме кита не записать; null — все годятся.</summary>
    public static FlowRejection? Validate(IReadOnlyList<FlowStep> steps)
    {
        for (var index = 0; index < steps.Count; index++)
        {
            var step = steps[index];
            FlowProblem? problem =
                string.IsNullOrWhiteSpace(step.Title) ? FlowProblem.EmptyTitle
                : string.IsNullOrWhiteSpace(step.Executor) ? FlowProblem.EmptyExecutor
                : string.IsNullOrWhiteSpace(step.Output) ? FlowProblem.EmptyOutput
                : new[] { step.Title, step.Executor, step.Output, step.Skip ?? "" }.Any(v => v.Contains('\n') || v.Contains('\r'))
                    ? FlowProblem.LineBreak
                    : null;
            if (problem is { } found)
                return new FlowRejection(index + 1, found);
        }
        return null;
    }

    // Строки как в файле, без пустых по краям; null — текста нет.
    private static string? Block(IEnumerable<string> lines)
    {
        var block = lines.Select(l => l.TrimEnd()).ToList();
        var first = block.FindIndex(l => l.Length > 0);
        return first < 0 ? null : string.Join("\n", block[first..(block.FindLastIndex(l => l.Length > 0) + 1)]);
    }
}
