using System.Text;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class OperatorAnswersTests
{
    private const string Memory = """
        # Задача
        рабочая копия: D:\Projects\app
        ветка: feat/x

        - Критерий закрытия: окно есть
        - Оператору: Подтвердить критерий?
          - контекст: за вами объём проверок
        - Оператору: Как быть с переносами?
          - контекст: ответ одной строкой
          - вариант: заменять пробелами — абзацы теряются
          - вариант: не отправлять — оператор переписывает
          - сессия за: заменять пробелами — проще
        - Решения: нет

        ## Шаги
        - [ ] Окно

        ## Флоу
        - [ ] 1. Критерий
        """;

    [Fact]
    public void Apply_WritesEachAnswerAsLastLineOfItsBlock()
    {
        var (text, rejection) = OperatorAnswers.Apply(Memory, [
            new("Как быть с переносами?", "заменять пробелами"),
            new("Подтвердить критерий?", "принимаю"),
        ]);

        Assert.Null(rejection);
        Assert.Equal(Memory
            .Replace("  - контекст: за вами объём проверок\n", "  - контекст: за вами объём проверок\n  - ответ: принимаю\n")
            .Replace("  - сессия за: заменять пробелами — проще\n", "  - сессия за: заменять пробелами — проще\n  - ответ: заменять пробелами\n"),
            text);
        Assert.False(WorkMemory.Parse(text!).WaitingForOperator);
    }

    [Fact]
    public void Apply_CrlfMemory_KeepsCrlf()
    {
        var crlf = Memory.Replace("\n", "\r\n");

        var (text, rejection) = OperatorAnswers.Apply(crlf, [new("Подтвердить критерий?", "да")]);

        Assert.Null(rejection);
        Assert.Equal(crlf.Replace("объём проверок\r\n", "объём проверок\r\n  - ответ: да\r\n"), text);
    }

    [Fact]
    public void Apply_BlockAtEndOfFileWithoutNewline_AddsLineBreakBeforeAnswer()
    {
        const string memory = "# Задача\n- Оператору: Да?\n  - контекст: к";

        var (text, _) = OperatorAnswers.Apply(memory, [new("Да?", "да")]);

        Assert.Equal("# Задача\n- Оператору: Да?\n  - контекст: к\n  - ответ: да", text);
    }

    [Fact]
    public void Apply_MultilineAnswer_IsWrittenAsOneLine()
    {
        var (text, _) = OperatorAnswers.Apply(Memory, [new("Подтвердить критерий?", "  принимаю,\r\n\r\n  но проверьте e2e \n")]);

        Assert.Contains("  - ответ: принимаю, но проверьте e2e\n", text);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" \n ")]
    public void Apply_EmptyAnswer_WritesNothing(string answer)
    {
        var (text, rejection) = OperatorAnswers.Apply(Memory, [
            new("Подтвердить критерий?", "принимаю"),
            new("Как быть с переносами?", answer),
        ]);

        Assert.Null(text);
        Assert.Equal(new AnswerRejection("Как быть с переносами?", AnswerProblem.Empty), rejection);
    }

    [Fact]
    public void Apply_AlreadyAnsweredQuestion_WritesNothing()
    {
        var answered = Memory.Replace("за вами объём проверок\n", "за вами объём проверок\n  - ответ: да\n");

        var (text, rejection) = OperatorAnswers.Apply(answered, [
            new("Как быть с переносами?", "заменять"),
            new("Подтвердить критерий?", "принимаю"),
        ]);

        Assert.Null(text);
        Assert.Equal(new AnswerRejection("Подтвердить критерий?", AnswerProblem.AlreadyAnswered), rejection);
    }

    [Fact]
    public void Apply_MissingQuestion_WritesNothing()
    {
        var (text, rejection) = OperatorAnswers.Apply(Memory, [new("Такого вопроса нет?", "да")]);

        Assert.Null(text);
        Assert.Equal(new AnswerRejection("Такого вопроса нет?", AnswerProblem.Missing), rejection);
    }

    [Fact]
    public void Apply_QuestionsInSectionsBelowHeader_AreIgnored()
    {
        var memory = Memory.Replace("- [ ] Окно", "- [ ] Окно\n- Оператору: не вопрос");

        var (_, rejection) = OperatorAnswers.Apply(memory, [new("не вопрос", "да")]);

        Assert.Equal(AnswerProblem.Missing, rejection?.Problem);
    }

    [Fact]
    public async Task WriteAsync_KeepsBomAndRestOfFileByteForByte()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("akw-answers-").FullName, "copy.md");
        var crlf = Memory.Replace("\n", "\r\n");
        await File.WriteAllBytesAsync(path, [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(crlf)]);

        var rejection = await OperatorAnswers.WriteAsync(path, [new("Подтвердить критерий?", "принимаю")], CancellationToken.None);

        Assert.Null(rejection);
        var expected = crlf.Replace("объём проверок\r\n", "объём проверок\r\n  - ответ: принимаю\r\n");
        Assert.Equal([0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(expected)], await File.ReadAllBytesAsync(path));
        Assert.Single(Directory.EnumerateFiles(Path.GetDirectoryName(path)!));
    }

    [Fact]
    public async Task WriteAsync_Rejected_LeavesFileUntouched()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("akw-answers-").FullName, "copy.md");
        await File.WriteAllTextAsync(path, Memory);
        var before = File.GetLastWriteTimeUtc(path);

        var rejection = await OperatorAnswers.WriteAsync(path, [new("Подтвердить критерий?", "")], CancellationToken.None);

        Assert.Equal(AnswerProblem.Empty, rejection?.Problem);
        Assert.Equal(Memory, await File.ReadAllTextAsync(path));
        Assert.Equal(before, File.GetLastWriteTimeUtc(path));
    }
}
