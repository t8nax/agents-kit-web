using System.Text;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record OperatorAnswer(string Question, string Answer);

public enum AnswerProblem
{
    /// <summary>Ответ пустой.</summary>
    Empty,
    /// <summary>Вопроса с таким заголовком в памяти нет.</summary>
    Missing,
    /// <summary>В блоке вопроса уже есть ответ.</summary>
    AlreadyAnswered,
}

/// <summary>Почему ответы не записаны; Question — первый вопрос, на котором запись остановилась.</summary>
public sealed record AnswerRejection(string Question, AnswerProblem Problem);

/// <summary>Запись ответов оператора в память: все ответы разом или ни одного.</summary>
public static class OperatorAnswers
{
    private static readonly Regex LineBreaks = new(@"\s*[\r\n]+\s*");
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    /// <summary>Ответ пишется одной строкой: переносы строк заменяются пробелами.</summary>
    public static string Normalize(string answer) => LineBreaks.Replace(answer.Trim(), " ");

    public static (string? Text, AnswerRejection? Rejection) Apply(string text, IReadOnlyList<OperatorAnswer> answers)
    {
        var normalized = answers.Select(a => a with { Answer = Normalize(a.Answer) }).ToList();
        if (normalized.FirstOrDefault(a => a.Answer.Length == 0) is { } empty)
            return (null, new AnswerRejection(empty.Question, AnswerProblem.Empty));

        var lines = MemoryText.Lines(text);
        var blocks = QuestionBlocks.Find(lines);
        var taken = new HashSet<QuestionBlock>();
        var edits = new List<(int Start, int End, string Text)>();
        var eol = text.Contains("\r\n") ? "\r\n" : "\n";

        foreach (var answer in normalized)
        {
            var sameTitle = blocks.Where(b => b.Question.Title == answer.Question.Trim()).ToList();
            var block = sameTitle.FirstOrDefault(b => b.Question.Answer is null && !taken.Contains(b));
            if (block is null)
            {
                var problem = sameTitle.Count == 0 ? AnswerProblem.Missing : AnswerProblem.AlreadyAnswered;
                return (null, new AnswerRejection(answer.Question, problem));
            }
            taken.Add(block);

            var answerLine = $"ответ: {answer.Answer}";
            if (block.AnswerLine is { } emptyLine)
            {
                // Пустая «ответ:» заменяется целиком, перевод строки после неё остаётся.
                edits.Add((emptyLine.Start, emptyLine.Start + emptyLine.Text.Length, answerLine));
            }
            else
            {
                // Строки «ответ:» нет — она дописывается последней в блоке, через пустую строку, как в форме кита.
                var last = block.LastLine;
                edits.Add(last.HasBreak
                    ? (last.End, last.End, eol + answerLine + eol)
                    : (last.End, last.End, eol + eol + answerLine));
            }
        }

        var result = new StringBuilder(text);
        foreach (var (start, end, replacement) in edits.OrderByDescending(e => e.Start))
            result.Remove(start, end - start).Insert(start, replacement);
        return (result.ToString(), null);
    }

    /// <summary>Дописывает ответы в файл памяти. Отказ — файл не тронут.</summary>
    public static async Task<AnswerRejection?> WriteAsync(
        string memoryPath, IReadOnlyList<OperatorAnswer> answers, CancellationToken cancellationToken)
    {
        var bytes = await File.ReadAllBytesAsync(memoryPath, cancellationToken);
        var hasBom = bytes.AsSpan().StartsWith(Utf8Bom);
        var text = new UTF8Encoding(false).GetString(bytes, hasBom ? Utf8Bom.Length : 0, bytes.Length - (hasBom ? Utf8Bom.Length : 0));

        var (updated, rejection) = Apply(text, answers);
        if (rejection is not null)
            return rejection;

        var output = new UTF8Encoding(false).GetBytes(updated!);
        var temp = memoryPath + ".panel-tmp";
        await File.WriteAllBytesAsync(temp, hasBom ? [.. Utf8Bom, .. output] : output, cancellationToken);
        File.Move(temp, memoryPath, overwrite: true);
        return null;
    }
}
