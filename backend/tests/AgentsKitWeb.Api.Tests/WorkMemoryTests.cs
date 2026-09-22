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

        ### 1. Таблица есть
        Оператор видит копии списком.
        Без обновления страницы.

        Второй абзац.

        ### 2. Строка ждёт
        Копия с вопросом отмечена.

        ### Не входит
        Health баз.

        ### Дизайн
        Макет таблицы: https://claude.ai/artifact/Old456

        ## Артефакты
        - макет таблицы: https://claude.ai/artifact/AbC123
        просто строка, не артефакт
        - спецификация: D:\Projects\app\spec.md
        - без адреса

        ## Оператору

        ## Агенту

        ### Критерии
        - 1. проверка: тест таблицы — где: App.test.tsx

        ### Вопросы

        ### Факты
        - [ ] не шаг флоу

        ### Флоу
        - [x] 1. Критерий — выход: подтверждён
        - [x] 2. Ветка — выход: feat/table
        - [ ] 3. Реализация
        - [ ] 4. Приёмка

        ### Шаги
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
        // Два шага флоу из четырёх и половина шагов работы открытого третьего.
        Assert.Equal(62, memory.Progress);
        Assert.Empty(memory.Questions);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_Criteria_ReadsTitleAndParagraphsOfEachSubsectionAndOutOfScopeApart()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.Equal(
            [
                new ClosingCriterion("1. Таблица есть", "Оператор видит копии списком.\nБез обновления страницы.\n\nВторой абзац."),
                new ClosingCriterion("2. Строка ждёт", "Копия с вопросом отмечена."),
            ],
            memory.Criteria);
        Assert.Equal("Health баз.", memory.OutOfScope);
    }

    [Fact]
    public void Parse_Artifacts_ReadsLabelAndAddressOfEachLineInFileOrder()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.Equal(
            [
                new TaskArtifact("макет таблицы", "https://claude.ai/artifact/AbC123"),
                new TaskArtifact("спецификация", @"D:\Projects\app\spec.md"),
            ],
            memory.Artifacts);
    }

    [Fact]
    public void Parse_OldDesignSubsection_IsNeitherCriterionNorArtifact()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.DoesNotContain(memory.Criteria, c => c.Title == "Дизайн");
        Assert.DoesNotContain(memory.Artifacts, a => a.Address.Contains("Old456"));
    }

    [Fact]
    public void Parse_WithoutArtifactsSection_HasNoArtifacts()
    {
        var start = Memory.IndexOf("## Артефакты", StringComparison.Ordinal);
        var memory = WorkMemory.Parse(Memory.Remove(start, Memory.IndexOf("## Оператору", StringComparison.Ordinal) - start));

        Assert.Empty(memory.Artifacts);
    }

    [Fact]
    public void Parse_CriterionWithoutText_HasNullText()
    {
        var memory = WorkMemory.Parse(Memory.Replace("Копия с вопросом отмечена.\n", ""));

        Assert.Null(memory.Criteria[1].Text);
    }

    [Fact]
    public void Parse_NoCriteriaSection_HasNoCriteria()
    {
        var memory = WorkMemory.Parse(Memory[..Memory.IndexOf("## Критерии закрытия", StringComparison.Ordinal)]
            + Memory[Memory.IndexOf("## Оператору", StringComparison.Ordinal)..]);

        Assert.Empty(memory.Criteria);
        Assert.Null(memory.OutOfScope);
    }

    [Fact]
    public void Parse_AgentCriteriaChecks_AreNotClosingCriteria()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.DoesNotContain(memory.Criteria, c => c.Title == "Критерии");
        Assert.Equal(2, memory.Criteria.Count);
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

    [Fact]
    public void Parse_QuestionContext_KeepsBlankLinesIndentsAndOtherKeyLines()
    {
        var memory = WithQuestions("""
            ### Куда переносить выгрузку?
            Папку отключают.

            Списком:
            - где: сетевая папка
            - вложенный пункт:
              - его подпункт

            - вариант: в хранилище — ссылки не откроются
            - рекомендовано: в хранилище — ссылки не откроются

            ответ:
            """);

        var question = Assert.Single(memory.Questions);
        Assert.Equal(
            """
            Папку отключают.

            Списком:
            - где: сетевая папка
            - вложенный пункт:
              - его подпункт
            """.ReplaceLineEndings("\n"),
            question.Context);
        Assert.Equal("в хранилище", Assert.Single(question.Variants).Choice);
    }

    [Fact]
    public void Parse_CriterionText_KeepsIndentsOfNestedList()
    {
        var memory = WorkMemory.Parse(Memory.Replace(
            "Копия с вопросом отмечена.\n",
            "Копия с вопросом отмечена:\n- бейджем\n  - и подсказкой\n"));

        Assert.Equal(
            """
            Копия с вопросом отмечена:
            - бейджем
              - и подсказкой
            """.ReplaceLineEndings("\n"),
            memory.Criteria[1].Text);
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
        var memory = WorkMemory.Parse(Memory.Replace("### Факты\n", "### Факты\n### не вопрос\n\nответ:\n"));

        Assert.Empty(memory.Questions);
    }

    [Fact]
    public void Parse_LastQuestion_StopsAtAgentPart()
    {
        var memory = WithQuestions("""
            ### Подтвердить критерии
            За вами объём проверок.

            ответ:
            """);

        var question = Assert.Single(memory.Questions);
        Assert.Equal("За вами объём проверок.", question.Context);
        Assert.Null(question.Answer);
    }

    [Fact]
    public void Parse_FlowOutsideAgentPart_IsNotRead()
    {
        var memory = WorkMemory.Parse(Memory.Replace("## Агенту\n", "## Флоу\n- [ ] 1. Старый флоу\n\n## Агенту\n")
            .Replace("### Флоу\n", "### Не флоу\n"));

        Assert.Null(memory.FlowStep);
        Assert.Null(memory.Progress);
    }

    [Fact]
    public void Parse_OldFormInHeader_HasNoQuestionsOrCriteria()
    {
        var memory = WorkMemory.Parse(Memory[..Memory.IndexOf("## Критерии закрытия", StringComparison.Ordinal)]
            .Replace("Решения: нет\n", "Решения: нет\n- Критерий закрытия: таблица есть\n- Оператору: подтвердите критерий\n  - контекст: к\n")
            + Memory[Memory.IndexOf("## Оператору", StringComparison.Ordinal)..]);

        Assert.Empty(memory.Questions);
        Assert.Empty(memory.Criteria);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_CriteriaAsListLines_AreNotRead()
    {
        var start = Memory.IndexOf("## Критерии закрытия", StringComparison.Ordinal);
        var end = Memory.IndexOf("## Оператору", StringComparison.Ordinal);
        var memory = WorkMemory.Parse(Memory[..start] + "## Критерии закрытия\n- таблица есть\n- не входит: health\n\n" + Memory[end..]);

        Assert.Empty(memory.Criteria);
        Assert.Null(memory.OutOfScope);
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
        Assert.Equal(new ClosingCriterion("1. Таблица есть", "Оператор видит копии списком.\nБез обновления страницы.\n\nВторой абзац."), memory.Criteria[0]);
        Assert.Equal("Health баз.", memory.OutOfScope);
        Assert.Equal("Реализация", memory.FlowStep);
    }

    [Fact]
    public void Parse_AllFlowStepsClosed_HasNoStepAndFullProgress()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- [ ] 3.", "- [x] 3.").Replace("- [ ] 4.", "- [x] 4."));

        Assert.Null(memory.FlowStep);
        Assert.Equal(100, memory.Progress);
    }

    [Fact]
    public void Parse_ClosedWorkStep_RaisesProgressInsideOpenFlowStep()
    {
        var noneDone = WorkMemory.Parse(Memory.Replace("- [x] API — результат: abc123", "- [ ] API"));

        Assert.Equal(50, noneDone.Progress);
        Assert.Equal(62, WorkMemory.Parse(Memory).Progress);
    }

    [Fact]
    public void Parse_NoWorkSteps_CountsFlowStepsAlone()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- [x] API — результат: abc123\n- [ ] Фронт", ""));

        Assert.Equal(50, memory.Progress);
    }

    [Fact]
    public void Parse_NextFlowStepOpened_KeepsProgressOfFullyDoneOpenStep()
    {
        var allWorkStepsDone = WorkMemory.Parse(Memory.Replace("- [ ] Фронт", "- [x] Фронт"));
        var nextFlowStep = WorkMemory.Parse(Memory
            .Replace("- [ ] 3. Реализация", "- [x] 3. Реализация — выход: abc123")
            .Replace("- [x] API — результат: abc123\n- [ ] Фронт", "- [ ] Позвать оператора"));

        Assert.Equal(75, allWorkStepsDone.Progress);
        Assert.Equal(75, nextFlowStep.Progress);
    }
}
