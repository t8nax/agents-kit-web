using System.Text;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class OperatorAnswersTests
{
    // Переводы строк приводятся к LF: при core.autocrlf=true сырая строка в исходнике получает CRLF.
    private static readonly string Memory = """
        # Задача
        рабочая копия: D:\Projects\app
        ветка: feat/x
        Решения: нет

        ## Критерии закрытия

        ### 1. Окно есть
        Оператор отвечает из панели.

        ## Оператору

        ### Подтвердить критерий?
        За вами объём проверок.

        ответ:

        ### Как быть с переносами?
        Ответ одной строкой.

        - вариант: заменять пробелами — абзацы теряются
        - вариант: не отправлять — оператор переписывает
        - рекомендовано: заменять пробелами — абзацы теряются

        ответ:

        ## Агенту

        ### Критерии
        - 1. проверка: тест окна — где: ReplyModal.test.tsx

        ### Вопросы
        - «Как быть с переносами?»: после ответа поправить Normalize

        ### Факты

        ### Флоу
        - [ ] 1. Критерий

        ### Шаги
        - [ ] Окно
        """.ReplaceLineEndings("\n");

    private const string FirstAnswer = "За вами объём проверок.\n\nответ:\n";
    private const string SecondAnswer = "- рекомендовано: заменять пробелами — абзацы теряются\n\nответ:\n";

    [Fact]
    public void Apply_WritesEachAnswerAfterColonOfItsEmptyAnswerLine()
    {
        var (text, rejection) = OperatorAnswers.Apply(Memory, [
            new("Как быть с переносами?", "заменять пробелами"),
            new("Подтвердить критерий?", "принимаю"),
        ]);

        Assert.Null(rejection);
        Assert.Equal(Memory
            .Replace(FirstAnswer, "За вами объём проверок.\n\nответ: принимаю\n")
            .Replace(SecondAnswer, "- рекомендовано: заменять пробелами — абзацы теряются\n\nответ: заменять пробелами\n"),
            text);
        Assert.False(WorkMemory.Parse(text!).WaitingForOperator);
    }

    [Fact]
    public void Apply_AnswerLineWithTrailingSpaces_IsReplacedWhole()
    {
        var memory = Memory.Replace(FirstAnswer, "За вами объём проверок.\n\nответ:   \n");

        var (text, _) = OperatorAnswers.Apply(memory, [new("Подтвердить критерий?", "да")]);

        Assert.Equal(Memory.Replace(FirstAnswer, "За вами объём проверок.\n\nответ: да\n"), text);
    }

    [Fact]
    public void Apply_QuestionWithoutAnswerLine_AppendsAnswerLastInBlock()
    {
        var memory = Memory.Replace(FirstAnswer, "За вами объём проверок.\n");

        var (text, rejection) = OperatorAnswers.Apply(memory, [new("Подтвердить критерий?", "да")]);

        Assert.Null(rejection);
        Assert.Equal(Memory.Replace(FirstAnswer, "За вами объём проверок.\n\nответ: да\n"), text);
        Assert.Equal("да", WorkMemory.Parse(text!).Questions[0].Answer);
    }

    [Fact]
    public void Apply_LastQuestionWithoutAnswerLine_AppendsAnswerBeforeAgentPart()
    {
        var memory = Memory.Replace(SecondAnswer, "- рекомендовано: заменять пробелами — абзацы теряются\n");

        var (text, rejection) = OperatorAnswers.Apply(memory, [new("Как быть с переносами?", "заменять")]);

        Assert.Null(rejection);
        Assert.Equal(Memory.Replace(SecondAnswer, "- рекомендовано: заменять пробелами — абзацы теряются\n\nответ: заменять\n"), text);
    }

    [Fact]
    public void Apply_BlockAtEndOfFileWithoutAnswerAndNewline_AddsAnswerAfterBlankLine()
    {
        const string memory = "# Задача\n\n## Оператору\n\n### Да?\nк";

        var (text, _) = OperatorAnswers.Apply(memory, [new("Да?", "да")]);

        Assert.Equal("# Задача\n\n## Оператору\n\n### Да?\nк\n\nответ: да", text);
    }

    [Fact]
    public void Apply_CrlfMemory_KeepsCrlf()
    {
        var crlf = Memory.Replace("\n", "\r\n");

        var (text, rejection) = OperatorAnswers.Apply(crlf, [new("Подтвердить критерий?", "да")]);

        Assert.Null(rejection);
        Assert.Equal(crlf.Replace("объём проверок.\r\n\r\nответ:\r\n", "объём проверок.\r\n\r\nответ: да\r\n"), text);
    }

    [Fact]
    public void Apply_CrlfMemoryWithoutAnswerLine_AppendsWithCrlf()
    {
        var crlf = Memory.Replace(FirstAnswer, "За вами объём проверок.\n").Replace("\n", "\r\n");

        var (text, _) = OperatorAnswers.Apply(crlf, [new("Подтвердить критерий?", "да")]);

        Assert.Equal(crlf.Replace("объём проверок.\r\n", "объём проверок.\r\n\r\nответ: да\r\n"), text);
    }

    [Fact]
    public void Apply_MultilineAnswer_IsWrittenAsOneLine()
    {
        var (text, _) = OperatorAnswers.Apply(Memory, [new("Подтвердить критерий?", "  принимаю,\r\n\r\n  но проверьте e2e \n")]);

        Assert.Contains("\nответ: принимаю, но проверьте e2e\n", text);
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
        var answered = Memory.Replace(FirstAnswer, "За вами объём проверок.\n\nответ: да\n");

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
    public void Apply_QuestionsOutsideOperatorSection_AreIgnored()
    {
        var memory = Memory.Replace("- [ ] Окно", "- [ ] Окно\n\n### не вопрос\n\nответ:");

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
        var expected = crlf.Replace("объём проверок.\r\n\r\nответ:\r\n", "объём проверок.\r\n\r\nответ: принимаю\r\n");
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
