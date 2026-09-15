using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class WorkMemoryTests
{
    private const string Memory = """
        # Таблица рабочих копий
        рабочая копия: D:\Projects\app
        ветка: feat/table

        - Критерий закрытия: таблица есть
        - Оператору: нечего
        - Решения: нет

        ## Шаги
        - [x] API — результат: abc123
        - [ ] Фронт

        ## Флоу
        - [x] 1. Критерий — выход: подтверждён
        - [x] 2. Ветка — выход: feat/table
        - [ ] 3. Реализация
        - [ ] 4. Приёмка
        """;

    [Fact]
    public void Parse_ReadsHeaderAndFirstOpenFlowStepWithoutNumber()
    {
        var memory = WorkMemory.Parse(Memory);

        Assert.Equal(@"D:\Projects\app", memory.Copy);
        Assert.Equal("feat/table", memory.Branch);
        Assert.Equal("Таблица рабочих копий", memory.Task);
        Assert.Equal("Реализация", memory.FlowStep);
        Assert.Equal(50, memory.Progress);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_QuestionWithoutAnswer_IsWaiting()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- Оператору: нечего", "- Оператору: подтвердите критерий"));

        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_AnsweredQuestion_IsNotWaiting()
    {
        var memory = WorkMemory.Parse(Memory.Replace(
            "- Оператору: нечего",
            "- Оператору: подтвердите критерий\n  - ответ: подтверждаю"));

        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_OneOfTwoQuestionsUnanswered_IsWaiting()
    {
        var memory = WorkMemory.Parse(Memory.Replace(
            "- Оператору: нечего",
            "- Оператору: первый\n  - ответ: да\n- Оператору: второй"));

        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_QuestionBlock_ReadsContextVariantsAndRecommendation()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- Оператору: нечего", """
            - Оператору: Как быть с переносами строк в ответе из панели?
              - контекст: ответ записывается в память одной строкой
              - вариант: заменять переносы пробелами — ответ пишется всегда, абзацы теряются
              - вариант: не отправлять ответ с переносом — оператор переписывает сам
              - сессия за: заменять пробелами — абзацы в ответе редки
            """));

        var question = Assert.Single(memory.Questions);
        Assert.Equal("Как быть с переносами строк в ответе из панели?", question.Title);
        Assert.Equal("ответ записывается в память одной строкой", question.Context);
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
                Assert.False(v.Recommended);
            });
        Assert.True(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_AnswerLastInBlockAfterOtherLines_IsNotWaiting()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- Оператору: нечего", """
            - Оператору: Подтвердить критерий?
              - контекст: за вами объём проверок
              - ответ: принимаю
            """));

        Assert.Equal("принимаю", Assert.Single(memory.Questions).Answer);
        Assert.False(memory.WaitingForOperator);
    }

    [Fact]
    public void Parse_RecommendationMatchingTwoVariantsEqually_MarksNone()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- Оператору: нечего", """
            - Оператору: Где гонять e2e?
              - контекст: dev-API смотрит в живую базу
              - вариант: подменять api — живая база не трогается
              - вариант: api на копии базы — прогон сложнее
              - сессия за: api — проще
            """));

        Assert.All(Assert.Single(memory.Questions).Variants, v => Assert.False(v.Recommended));
    }

    [Fact]
    public void Parse_Criterion_ReadsSubLines()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- Критерий закрытия: таблица есть", """
            - Критерий закрытия:
              1. Таблица есть.
              Не входит: health.
            """));

        Assert.Equal(["1. Таблица есть.", "Не входит: health."], memory.Criterion);
    }

    [Fact]
    public void Parse_CrlfMemory_ReadsQuestions()
    {
        var memory = WorkMemory.Parse(Memory
            .Replace("- Оператору: нечего", "- Оператору: первый\n  - контекст: к\n  - ответ: да")
            .Replace("\n", "\r\n"));

        Assert.Equal("да", Assert.Single(memory.Questions).Answer);
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
