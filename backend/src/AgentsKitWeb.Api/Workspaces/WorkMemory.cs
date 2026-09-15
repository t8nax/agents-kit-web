using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Вариант ответа из строки «вариант: что выбрать — что изменит».</summary>
public sealed record QuestionVariant(string Choice, string? Effect, bool Recommended);

/// <summary>Блок вопроса «Оператору:» с его строками.</summary>
public sealed record OperatorQuestion(
    string Title,
    string? Context,
    IReadOnlyList<QuestionVariant> Variants,
    string? Answer);

/// <summary>Рабочая память задачи — файл work/*.md базы.</summary>
public sealed record WorkMemory(
    string? Copy,
    string? Branch,
    string? Task,
    string? FlowStep,
    int? Progress,
    IReadOnlyList<string> Criterion,
    IReadOnlyList<OperatorQuestion> Questions)
{
    public bool WaitingForOperator => Questions.Any(q => q.Answer is null);

    private static readonly Regex FlowItem = new(@"^- \[(?<done>[ xX])\]\s*(?:\d+\.\s*)?(?<name>.*)$");
    private static readonly Regex CriterionHeader = new(@"^- Критерий закрытия:\s*(?<text>.*)$");
    private static readonly Regex SubLine = new(@"^\s+\S");

    public static WorkMemory Parse(string text)
    {
        var lines = MemoryText.Lines(text);

        string? copy = null, branch = null, task = null;
        var criterion = new List<string>();
        var flowTotal = 0;
        var flowDone = 0;
        string? flowStep = null;
        string? section = null;

        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i].Text;

            if (line.StartsWith("## "))
            {
                section = line[3..].Trim();
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
                else if (CriterionHeader.Match(line) is { Success: true } header)
                {
                    if (header.Groups["text"].Value.Trim() is { Length: > 0 } inline)
                        criterion.Add(inline);
                    while (i + 1 < lines.Count && SubLine.IsMatch(lines[i + 1].Text))
                        criterion.Add(lines[++i].Text.Trim());
                }
                continue;
            }

            if (section == "Флоу" && FlowItem.Match(line) is { Success: true } item)
            {
                flowTotal++;
                if (item.Groups["done"].Value != " ")
                    flowDone++;
                else
                    flowStep ??= StepName(item.Groups["name"].Value);
            }
        }

        int? progress = flowTotal == 0 ? null : (int)Math.Round(flowDone * 100.0 / flowTotal);
        var questions = QuestionBlocks.Find(lines).Select(b => b.Question).ToList();
        return new WorkMemory(copy, branch, task, flowStep, progress, criterion, questions);
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

/// <summary>Блок вопроса и конец его последней строки — место, куда дописывается ответ.</summary>
internal sealed record QuestionBlock(OperatorQuestion Question, MemoryLine LastLine);

internal static class QuestionBlocks
{
    private static readonly Regex Header = new(@"^- Оператору:\s*(?<text>.*)$");
    private static readonly Regex KeyLine = new(@"^\s+- (?<key>[^:]+):\s*(?<value>.*)$");
    private static readonly Regex Word = new(@"[\p{L}\p{N}]{3,}");

    /// <summary>Вопросы из шапки памяти — до первого раздела «## ».</summary>
    public static IReadOnlyList<QuestionBlock> Find(IReadOnlyList<MemoryLine> lines)
    {
        var blocks = new List<QuestionBlock>();
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i].Text;
            if (line.StartsWith("## "))
                break;
            if (Header.Match(line) is not { Success: true } header)
                continue;

            var title = header.Groups["text"].Value.Trim();
            string? context = null, answer = null, sessionFor = null;
            var variants = new List<(string Choice, string? Effect)>();
            var last = lines[i];

            while (i + 1 < lines.Count && KeyLine.Match(lines[i + 1].Text) is { Success: true } key)
            {
                last = lines[++i];
                var value = key.Groups["value"].Value.Trim();
                switch (key.Groups["key"].Value.Trim())
                {
                    case "контекст": context = value; break;
                    case "вариант": variants.Add(SplitVariant(value)); break;
                    case "сессия за": sessionFor = value; break;
                    case "ответ": answer = value; break;
                }
            }

            if (title == "нечего")
                continue;

            var recommended = Recommended(variants.Select(v => v.Choice).ToList(), sessionFor);
            var question = new OperatorQuestion(
                title,
                context,
                variants.Select((v, n) => new QuestionVariant(v.Choice, v.Effect, n == recommended)).ToList(),
                answer);
            blocks.Add(new QuestionBlock(question, last));
        }
        return blocks;
    }

    // «заменять пробелами — ответ пишется всегда» → («заменять пробелами», «ответ пишется всегда»)
    private static (string Choice, string? Effect) SplitVariant(string value)
    {
        var dash = value.IndexOf(" — ", StringComparison.Ordinal);
        return dash < 0 ? (value, null) : (value[..dash].Trim(), value[(dash + 3)..].Trim());
    }

    // «сессия за» пишется своими словами, а не копией варианта: берётся вариант,
    // у выбора которого с ней больше всего общих слов (по первым пяти буквам). Ничья — отметки нет.
    private static int Recommended(IReadOnlyList<string> choices, string? sessionFor)
    {
        if (sessionFor is null || choices.Count == 0)
            return -1;

        var wanted = Stems(SplitVariant(sessionFor).Choice);
        var scores = choices.Select(c => Stems(c).Count(wanted.Contains)).ToList();
        var best = scores.Max();
        return best > 0 && scores.Count(s => s == best) == 1 ? scores.IndexOf(best) : -1;
    }

    private static HashSet<string> Stems(string text) =>
        Word.Matches(text.ToLowerInvariant())
            .Select(m => m.Value.Length > 5 ? m.Value[..5] : m.Value)
            .ToHashSet();
}
