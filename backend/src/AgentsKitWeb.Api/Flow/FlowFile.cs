using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Возврат шага: при Condition работа идёт заново к шагу Step, который стоит во флоу раньше.</summary>
public sealed record FlowReturn(string Condition, string Step);

/// <summary>
/// Шаг флоу проекта. Description — описание шага как в файле: абзацы, списки и пункты «N.1.»; панель его не показывает,
/// а переносит при записи, меняя в пунктах номер шага. Returns — возвраты шага, строка на каждый; Helpers — помощники,
/// которых оркестратор зовёт внутри шага.
/// </summary>
public sealed record FlowStep(
    string Title,
    string Executor,
    string Output,
    string? Skip,
    string? Description,
    IReadOnlyList<FlowReturn>? Returns = null,
    IReadOnlyList<string>? Helpers = null)
{
    // Списки record сравнивает ссылками, поэтому два одинаковых шага вышли бы разными: равенство задано по значению.
    public bool Equals(FlowStep? other) =>
        other is not null
        && Title == other.Title
        && Executor == other.Executor
        && Output == other.Output
        && Skip == other.Skip
        && Description == other.Description
        && FlowFile.Returns(this).SequenceEqual(FlowFile.Returns(other))
        && FlowFile.Helpers(this).SequenceEqual(FlowFile.Helpers(other));

    public override int GetHashCode() => HashCode.Combine(Title, Executor, Output, Skip, Description);
}

/// <summary>Файл флоу: шапка до первого шага — как в файле, с HTML-комментарием, — и шаги по порядку.</summary>
public sealed record FlowDocument(string Header, IReadOnlyList<FlowStep> Steps);

public enum FlowProblem
{
    EmptyTitle,
    EmptyExecutor,
    EmptyOutput,
    /// <summary>В однострочном поле перевод строки: ключ шага в файле — одна строка.</summary>
    LineBreak,
    /// <summary>Возврат без условия: по чему работа идёт назад, не сказано.</summary>
    ReturnWithoutCondition,
    /// <summary>Возврат ведёт на шаг, которого во флоу нет.</summary>
    ReturnUnknownStep,
    /// <summary>Возврат ведёт на шаг, который стоит не раньше этого: круга из него не выйдет.</summary>
    ReturnStepNotEarlier,
}

/// <summary>Почему флоу не записан; Step — номер шага с единицы.</summary>
public sealed record FlowRejection(int Step, FlowProblem Problem);

/// <summary>Разбор и запись flow.md базы в форме шага кита (раздел «Флоу проекта» раскладки базы).</summary>
public static partial class FlowFile
{
    public const string FileName = "flow.md";

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    /// <summary>Отпечаток файла: по нему видно, что флоу не разошёлся с тем, который читали.</summary>
    public static string Fingerprint(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>Текст файла без BOM; HasBom — писать ли его обратно.</summary>
    public static (string Text, bool HasBom) Decode(byte[] bytes)
    {
        var hasBom = bytes.AsSpan().StartsWith(Utf8Bom);
        var offset = hasBom ? Utf8Bom.Length : 0;
        return (new UTF8Encoding(false).GetString(bytes, offset, bytes.Length - offset), hasBom);
    }

    /// <summary>Байты файла: текст в UTF-8, BOM — если он там был.</summary>
    public static byte[] Encode(string text, bool hasBom)
    {
        var bytes = new UTF8Encoding(false).GetBytes(text);
        return hasBom ? [.. Utf8Bom, .. bytes] : bytes;
    }

    // «## 3. Реализация» → «Реализация». Раздел «##» без номера тоже шаг: номер ставит запись.
    [GeneratedRegex(@"^##\s+(?:\d+\.\s*)?(?<title>.*)$")]
    private static partial Regex StepHeading { get; }

    // Ключи шага — закрытый перечень кита.
    [GeneratedRegex(@"^(?<key>исполнитель|помощники|выход|пропуск|возврат):\s*(?<value>.*)$")]
    private static partial Regex KeyLine { get; }

    // «есть замечания — стадия «Реализация»» → условие и название стадии. Форма возврата задана китом;
    // прежняя запись «— шаг «…»» панелью не принимается — решение оператора на B-132.
    [GeneratedRegex(@"^(?<condition>.*?)\s*—\s*стадия\s*«(?<step>[^»]*)»\s*$")]
    private static partial Regex ReturnValue { get; }

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
            var returns = new List<FlowReturn>();

            // Ключи идут подряд под заголовком; пустые строки перед ними пропускаются.
            while (i < lines.Length && lines[i].Trim().Length == 0)
                i++;
            while (i < lines.Length && KeyLine.Match(lines[i]) is { Success: true } key)
            {
                var value = key.Groups["value"].Value.Trim();
                // Возврат — строка на каждый круг, поэтому он копится списком, а не ложится в словарь.
                if (key.Groups["key"].Value == "возврат")
                    returns.Add(ParseReturn(value));
                else
                    keys.TryAdd(key.Groups["key"].Value, value);
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
                Block(description),
                returns,
                ParseHelpers(keys.GetValueOrDefault("помощники", ""))));
        }

        return new FlowDocument(Block(header) ?? "", steps);
    }

    /// <summary>
    /// Значение ключа «возврат». Строка не в форме кита целиком считается условием: панель её не теряет,
    /// а показывает возврат без цели — такой флоу не записывается, пока оператор его не починит.
    /// </summary>
    private static FlowReturn ParseReturn(string value) =>
        ReturnValue.Match(value) is { Success: true } match
            ? new FlowReturn(match.Groups["condition"].Value.Trim(), match.Groups["step"].Value.Trim())
            : new FlowReturn(value, "");

    private static IReadOnlyList<string> ParseHelpers(string value) =>
        value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

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
            // Порядок ключей — как в раскладке кита: помощники сразу за исполнителем, возвраты последними.
            if (Helpers(step) is { Count: > 0 } helpers)
                block.Append($"помощники: {string.Join(", ", helpers)}\n");
            block.Append($"выход: {step.Output.Trim()}");
            if (!string.IsNullOrWhiteSpace(step.Skip))
                block.Append($"\nпропуск: {step.Skip.Trim()}");
            foreach (var back in Returns(step))
                block.Append($"\nвозврат: {back.Condition.Trim()} — стадия «{back.Step.Trim()}»");
            if (Block(step.Description?.Replace("\r\n", "\n").Split('\n') ?? []) is { } description)
                block.Append("\n\n").Append(Renumber(description, number));
            parts.Add(block.ToString());
        }

        return (string.Join("\n\n", parts) + "\n").Replace("\n", eol);
    }

    public static string Renumber(string description, int number) =>
        PointNumber.Replace(description, m => $"{m.Groups["indent"].Value}{number}{m.Groups["rest"].Value}");

    /// <summary>Возвраты шага; null у шага без них.</summary>
    public static IReadOnlyList<FlowReturn> Returns(FlowStep step) => step.Returns ?? [];

    /// <summary>Помощники шага без пустых имён; null у шага без них.</summary>
    public static IReadOnlyList<string> Helpers(FlowStep step) =>
        (step.Helpers ?? []).Select(h => h.Trim()).Where(h => h.Length > 0).ToList();

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
                : Lines(step).Any(v => v.Contains('\n') || v.Contains('\r')) ? FlowProblem.LineBreak
                : ReturnProblem(steps, index);
            if (problem is { } found)
                return new FlowRejection(index + 1, found);
        }
        return null;
    }

    // Однострочные поля шага: перевод строки в любом из них файл в форме кита не примет.
    private static IEnumerable<string> Lines(FlowStep step) =>
        new[] { step.Title, step.Executor, step.Output, step.Skip ?? "" }
            .Concat(Helpers(step))
            .Concat(Returns(step).SelectMany(back => new[] { back.Condition, back.Step }));

    /// <summary>Возврат ведёт на шаг, стоящий раньше этого, и называет условие; иначе круга из него не выйдет.</summary>
    private static FlowProblem? ReturnProblem(IReadOnlyList<FlowStep> steps, int index)
    {
        foreach (var back in Returns(steps[index]))
        {
            if (string.IsNullOrWhiteSpace(back.Condition))
                return FlowProblem.ReturnWithoutCondition;

            var target = -1;
            for (var i = 0; i < steps.Count; i++)
                if (steps[i].Title.Trim() == back.Step.Trim() && back.Step.Trim().Length > 0)
                {
                    target = i;
                    break;
                }

            if (target < 0)
                return FlowProblem.ReturnUnknownStep;
            if (target >= index)
                return FlowProblem.ReturnStepNotEarlier;
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
