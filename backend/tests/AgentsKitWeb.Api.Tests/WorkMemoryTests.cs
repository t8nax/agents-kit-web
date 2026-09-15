using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class WorkMemoryTests
{
    // Переводы строк приводятся к LF: при core.autocrlf=true сырая строка в исходнике получает CRLF.
    private static readonly string Memory = """
        # Таблица рабочих копий
        рабочая копия: D:\Projects\app
        ветка: feat/table
        Решения: нет

        ## Критерии закрытия
        - таблица есть
        - не входит: health

        ## Условия

        ## Оператору

        ## Флоу
        - [x] 1. Критерий — выход: подтверждён
        - [x] 2. Ветка — выход: feat/table
        - [ ] 3. Реализация
        - [ ] 4. Приёмка

        ## Шаги
        - [x] API — результат: abc123
        - [ ] Фронт
        """.ReplaceLineEndings("\n");

    private static WorkMemory WithQuestions(string questions) =>
        WorkMemory.Parse(Memory.Replace("## Оператору\n", "## Оператору\n\n" + questions.ReplaceLineEndings("\n") + "\n"));

    [Fact]
    public void Parse_ReadsHeaderAndFirstOpenFlowStepWithoutNumber()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.Equal(@"D:\Projects\app", memory.Copy);
        Assert.Equal("feat/table", memory.Branch);
        Assert.Equal("Таблица рабочих копий", memory.Task);
        Assert.Equal("Реализация", memory.FlowStep);
        Assert.Equal(50, memory.Progress);
        Assert.Empty(memory.Questions);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_Criteria_ReadsLinesOfCriteriaSectionWithOutOfScope()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.Equal(["таблица есть", "не входит: health"], memory.Criterion);
    }

    [Fact]
    public void Parse_NoCriteriaSection_HasNoCriterion()
    {
        var memory = WorkMemory.Parse(Memory.Replace("## Критерии закрытия\n- таблица есть\n- не входит: health\n", ""));

        Assert.Empty(memory.Criterion);
    }

    [Fact]
    public void Parse_QuestionWithEmptyAnswer_IsWaiting()
    {
        var memory = WithQuestions("""
            ### Подтвердить критерии
            За вами объём проверок.

            ответ:
            """);

        Assert.Null(Assert.Single(memory.Questions).Answer);
        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_QuestionWithoutAnswerLine_IsWaiting()
    {
        var memory = WithQuestions("""
            ### Подтвердить критерии
            За вами объём проверок.
            """);

        Assert.Null(Assert.Single(memory.Questions).Answer);
        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_AnsweredQuestion_IsNotWaiting()
    {
        var memory = WithQuestions("""
            ### Подтвердить критерии
            За вами объём проверок.

            ответ: да
            """);

        Assert.Equal("да", Assert.Single(memory.Questions).Answer);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_OneOfTwoQuestionsUnanswered_IsWaiting()
    {
        var memory = WithQuestions("""
            ### Первый
            к

            ответ: да

            ### Второй
            к

            ответ:
            """);

        Assert.Equal(["Первый", "Второй"], memory.Questions.Select(q => q.Title));
        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_QuestionBlock_ReadsContextVariantsAndExactRecommendation()
    {
        var memory = WithQuestions("""
            ### Как быть с переносами строк в ответе из панели?
            Ответ записывается в память одной строкой.
            Абзацы в ответах редки.

            - вариант: заменять переносы пробелами — ответ пишется всегда, абзацы теряются
            - вариант: не отправлять ответ с переносом — оператор переписывает сам
            - рекомендовано: заменять переносы пробелами — ответ пишется всегда, абзацы теряются

            ответ:
            """);

        var question = Assert.Single(memory.Questions);
        Assert.Equal("Как быть с переносами строк в ответе из панели?", question.Title);
        Assert.Equal("Ответ записывается в память одной строкой.\nАбзацы в ответах редки.", question.Context);
        Assert.Null(question.Answer);
        Assert.Collection(question.Variants,
            v =>
            {
                Assert.Equal("заменять переносы пробелами", v.Choice);
                Assert.Equal("ответ пишется всегда, абзацы теряются", v.Effect);
                Assert.True(v.Recommended);
            },
            v =>
            {
                Assert.Equal("не отправлять ответ с переносом", v.Choice);
                Assert.Equal("оператор переписывает сам", v.Effect);
                Assert.False(v.Recommended);
            });
    }

    [Theory]
    [InlineData("заменять переносы пробелами")]
    [InlineData("заменять пробелами — проще")]
    public void Parse_RecommendationNotWordForWord_MarksNone(string recommended)
    {
        var memory = WithQuestions($"""
            ### Как быть с переносами?
            к

            - вариант: заменять переносы пробелами — абзацы теряются
            - вариант: не отправлять — оператор переписывает
            - рекомендовано: {recommended}

            ответ:
            """);

        Assert.All(Assert.Single(memory.Questions).Variants, v => Assert.False(v.Recommended));
    }

    [Fact]
    public void Parse_QuestionsOutsideOperatorSection_AreIgnored()
    {
        var memory = WorkMemory.Parse(Memory.Replace("## Условия\n", "## Условия\n### не вопрос\n\nответ:\n"));

        Assert.Empty(memory.Questions);
    }

    [Fact]
    public void Parse_OldFormInHeader_HasNoQuestionsOrCriterion()
    {
        var memory = WorkMemory.Parse(Memory
            .Replace("## Критерии закрытия\n- таблица есть\n- не входит: health\n", "")
            .Replace("Решения: нет\n", "Решения: нет\n- Критерий закрытия: таблица есть\n- Оператору: подтвердите критерий\n  - контекст: к\n"));

        Assert.Empty(memory.Questions);
        Assert.Empty(memory.Criterion);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_CrlfMemory_ReadsQuestionsAndCriteria()
    {
        var memory = WorkMemory.Parse(Memory
            .Replace("## Оператору\n", "## Оператору\n\n### Первый\nк\n\nответ: да\n")
            .Replace("\n", "\r\n"));

        var question = Assert.Single(memory.Questions);
        Assert.Equal("Первый", question.Title);
        Assert.Equal("к", question.Context);
        Assert.Equal("да", question.Answer);
        Assert.Equal(["таблица есть", "не входит: health"], memory.Criterion);
        Assert.Equal("Реализация", memory.FlowStep);
    }

    [Fact]
    public void Parse_AllFlowStepsClosed_HasNoStepAndFullProgress()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- [ ] 3.", "- [x] 3.").Replace("- [ ] 4.", "- [x] 4."));

        Assert.Null(memory.FlowStep);
        Assert.Equal(100, memory.Progress);
    }
}
