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
    public void Parse_AllFlowStepsClosed_HasNoStepAndFullProgress()
    {
        var memory = WorkMemory.Parse(Memory.Replace("- [ ] 3.", "- [x] 3.").Replace("- [ ] 4.", "- [x] 4."));

        Assert.Null(memory.FlowStep);
        Assert.Equal(100, memory.Progress);
    }
}
