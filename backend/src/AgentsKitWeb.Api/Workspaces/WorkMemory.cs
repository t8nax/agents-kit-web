using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Вариант ответа из строки «вариант: что выбрать — что изменит».</summary>
public sealed record QuestionVariant(string Choice, string? Effect, bool Recommended);

/// <summary>Вопрос — подраздел «###» раздела «## Оператору».</summary>
public sealed record OperatorQuestion(
    string Title,
    string? Context,
    IReadOnlyList<QuestionVariant> Variants,
    string? Answer);

/// <summary>Критерий закрытия — подраздел «### N. признак» и текст оператору под ним.</summary>
public sealed record ClosingCriterion(string Title, string? Text);

/// <summary>Рабочая память задачи — файл work/*.md базы.</summary>
public sealed record WorkMemory(
    string? Copy,
    string? Branch,
    string? Task,
    string? FlowStep,
    int? Progress,
    IReadOnlyList<ClosingCriterion> Criteria,
    string? OutOfScope,
    IReadOnlyList<OperatorQuestion> Questions)
{
    private const string OutOfScopeTitle = "Не входит";

    public bool WaitingForOperator => Questions.Any(q => q.Answer is null);

    private static readonly Regex FlowItem = new(@"^- \[(?<done>[ xX])\]\s*(?:\d+\.\s*)?(?<name>.*)$");

    public static WorkMemory Parse(string text)
    {
        var lines = MemoryText.Lines(text);

        string? copy = null, branch = null, task = null;
        // Подразделы критериев в порядке файла: заголовок и строки текста под ним.
        var criteriaBlocks = new List<(string Title, List<string> Lines)>();
        var flowTotal = 0;
        var flowDone = 0;
        string? flowStep = null;
        string? section = null, subsection = null;

        foreach (var memoryLine in lines)
        {
            var line = memoryLine.Text;

            if (line.StartsWith("## "))
            {
                section = line[3..].Trim();
                subsection = null;
                continue;
            }
            if (line.StartsWith("### "))
            {
                subsection = line[4..].Trim();
                if (section == "Критерии закрытия")
                    criteriaBlocks.Add((subsection, []));
                continue;
            }

            if (section is null)
            {
                if (task is null && line.StartsWith("# "))
                    task = line[2..].Trim();
                else if (line.StartsWith("рабочая копия:"))
                    copy = line["рабочая копия:".Length..].Trim();
                else if (line.StartsWith("ветка:"))
                    branch = line["ветка:".Length..].Trim();
                continue;
            }

            if (section == "Критерии закрытия" && subsection is not null)
            {
                criteriaBlocks[^1].Lines.Add(line);
                continue;
            }

            if (section == "Агенту" && subsection == "Флоу" && FlowItem.Match(line) is { Success: true } flowItem)
            {
                flowTotal++;
                if (flowItem.Groups["done"].Value != " ")
                    flowDone++;
                else
                    flowStep ??= StepName(flowItem.Groups["name"].Value);
            }
        }

        int? progress = flowTotal == 0 ? null : (int)Math.Round(flowDone * 100.0 / flowTotal);
        var questions = QuestionBlocks.Find(lines).Select(b => b.Question).ToList();
        var criteria = criteriaBlocks
            .Where(b => b.Title != OutOfScopeTitle)
            .Select(b => new ClosingCriterion(b.Title, Paragraphs(b.Lines)))
            .ToList();
        var outOfScope = criteriaBlocks.Where(b => b.Title == OutOfScopeTitle).Select(b => Paragraphs(b.Lines)).FirstOrDefault();
        return new WorkMemory(copy, branch, task, flowStep, progress, criteria, outOfScope, questions);
    }

    // Строки абзаца — через «\n», абзацы — через пустую строку; пустые строки по краям и повторные не сохраняются.
    private static string? Paragraphs(IEnumerable<string> lines)
    {
        var paragraphs = new List<List<string>> { new() };
        foreach (var line in lines.Select(l => l.Trim()))
        {
            if (line.Length > 0)
                paragraphs[^1].Add(line);
            else if (paragraphs[^1].Count > 0)
                paragraphs.Add([]);
        }
        var text = string.Join("\n\n", paragraphs.Where(p => p.Count > 0).Select(p => string.Join("\n", p)));
        return text.Length == 0 ? null : text;
    }

    // «Реализация — выход: …» → «Реализация»
    private static string StepName(string item)
    {
        var dash = item.IndexOf(" — ", StringComparison.Ordinal);
        return (dash < 0 ? item : item[..dash]).Trim();
    }
}

/// <summary>Строка файла памяти: текст без перевода строки и её место в исходном тексте.</summary>
internal readonly record struct MemoryLine(string Text, int Start, int End, bool HasBreak);

internal static class MemoryText
{
    public static IReadOnlyList<MemoryLine> Lines(string text)
    {
        var lines = new List<MemoryLine>();
        var start = 0;
        while (start < text.Length)
        {
            var newline = text.IndexOf('\n', start);
            if (newline < 0)
            {
                lines.Add(new MemoryLine(text[start..], start, text.Length, false));
                break;
            }
            var contentEnd = newline > start && text[newline - 1] == '\r' ? newline - 1 : newline;
            lines.Add(new MemoryLine(text[start..contentEnd], start, newline + 1, true));
            start = newline + 1;
        }
        return lines;
    }
}

/// <summary>
/// Блок вопроса: строка «ответ:», если она есть, и последняя непустая строка блока —
/// после неё дописывается ответ, когда строки «ответ:» нет.
/// </summary>
internal sealed record QuestionBlock(OperatorQuestion Question, MemoryLine? AnswerLine, MemoryLine LastLine);

internal static class QuestionBlocks
{
    private static readonly Regex KeyLine = new(@"^- (?<key>[^:]+):\s*(?<value>.*)$");
    private static readonly Regex AnswerLine = new(@"^ответ:(?<value>.*)$");

    /// <summary>Вопросы — подразделы «### » раздела «## Оператору».</summary>
    public static IReadOnlyList<QuestionBlock> Find(IReadOnlyList<MemoryLine> lines)
    {
        var blocks = new List<QuestionBlock>();
        var inOperator = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i].Text;
            if (line.StartsWith("## "))
            {
                inOperator = line[3..].Trim() == "Оператору";
                continue;
            }
            if (!inOperator || !line.StartsWith("### "))
                continue;

            var title = line[4..].Trim();
            var context = new List<string>();
            var variants = new List<string>();
            string? recommended = null, answer = null;
            MemoryLine? answerLine = null;
            var last = lines[i];

            while (i + 1 < lines.Count && !lines[i + 1].Text.StartsWith("## ") && !lines[i + 1].Text.StartsWith("### "))
            {
                var current = lines[++i];
                var text = current.Text.Trim();
                if (text.Length == 0)
                    continue;
                last = current;

                if (AnswerLine.Match(current.Text) is { Success: true } answerMatch)
                {
                    answerLine ??= current;
                    answer ??= answerMatch.Groups["value"].Value.Trim() is { Length: > 0 } value ? value : null;
                }
                else if (KeyLine.Match(current.Text) is { Success: true } key)
                {
                    var value = key.Groups["value"].Value.Trim();
                    switch (key.Groups["key"].Value.Trim())
                    {
                        case "вариант": variants.Add(value); break;
                        case "рекомендовано": recommended = value; break;
                    }
                }
                else
                {
                    context.Add(text);
                }
            }

            var question = new OperatorQuestion(
                title,
                context.Count == 0 ? null : string.Join("\n", context),
                variants.Select(v => Variant(v, recommended)).ToList(),
                answer);
            blocks.Add(new QuestionBlock(question, answerLine, last));
        }
        return blocks;
    }

    // «заменять пробелами — ответ пишется всегда» → («заменять пробелами», «ответ пишется всегда»).
    // «рекомендовано:» повторяет вариант слово в слово — сравнивается значение строки целиком.
    private static QuestionVariant Variant(string value, string? recommended)
    {
        var dash = value.IndexOf(" — ", StringComparison.Ordinal);
        return dash < 0
            ? new QuestionVariant(value, null, value == recommended)
            : new QuestionVariant(value[..dash].Trim(), value[(dash + 3)..].Trim(), value == recommended);
    }
}
