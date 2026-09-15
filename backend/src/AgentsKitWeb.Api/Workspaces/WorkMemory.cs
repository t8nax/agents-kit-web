using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Рабочая память задачи — файл work/*.md базы.</summary>
public sealed record WorkMemory(
    string? Copy,
    string? Branch,
    string? Task,
    string? FlowStep,
    int? Progress,
    bool WaitingForOperator)
{
    private static readonly Regex FlowItem = new(@"^- \[(?<done>[ xX])\]\s*(?:\d+\.\s*)?(?<name>.*)$");
    private static readonly Regex OperatorQuestion = new(@"^- Оператору:\s*(?<text>.*)$");
    private static readonly Regex OperatorAnswer = new(@"^\s+- ответ:");

    public static WorkMemory Parse(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');

        string? copy = null, branch = null, task = null;
        var waiting = false;
        var flowTotal = 0;
        var flowDone = 0;
        string? flowStep = null;
        string? section = null;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];

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
                else if (OperatorQuestion.Match(line) is { Success: true } question
                         && question.Groups["text"].Value.Trim() != "нечего"
                         && !(i + 1 < lines.Length && OperatorAnswer.IsMatch(lines[i + 1])))
                    waiting = true;
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
        return new WorkMemory(copy, branch, task, flowStep, progress, waiting);
    }

    // «Реализация — выход: …» → «Реализация»
    private static string StepName(string item)
    {
        var dash = item.IndexOf(" — ", StringComparison.Ordinal);
        return (dash < 0 ? item : item[..dash]).Trim();
    }
}
