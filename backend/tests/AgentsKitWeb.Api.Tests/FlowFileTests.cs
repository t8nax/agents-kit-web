using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowFileTests
{
    private const string Flow = """
        # App — флоу

        <!-- Как на этом проекте ведут задачу — шаги от взятия задачи до закрытия. -->

        ## 1. Критерий

        исполнитель: оркестратор
        выход: критерий закрытия в памяти

        1.1. Написать критерий до первой строчки кода.
           1.1.1. Всё, что выходит за функциональность, назвать явно.
        1.2. Вынести критерий на подтверждение.

        ## 2. Ревью

        исполнитель: reviewer
        выход: вердикт по sha, записанный оркестратором
        пропуск: правка только в текстах

        2.1. Собрать дифф всей ветки задачи.
           Ревью идёт по диффу всей ветки, а не по последнему коммиту.

        ## 3. Приёмка

        исполнитель: оператор
        выход: ответ оператора «принято»

        """;

    [Fact]
    public void Parse_ReadsHeaderStepsKeysAndRawDescription()
    {
        var document = FlowFile.Parse(Flow.ReplaceLineEndings("\n"));

        Assert.Equal("# App — флоу\n\n<!-- Как на этом проекте ведут задачу — шаги от взятия задачи до закрытия. -->", document.Header);
        Assert.Equal(["Критерий", "Ревью", "Приёмка"], document.Steps.Select(s => s.Title));
        Assert.Equal(new FlowStep(
            "Ревью",
            "reviewer",
            "вердикт по sha, записанный оркестратором",
            "правка только в текстах",
            "2.1. Собрать дифф всей ветки задачи.\n   Ревью идёт по диффу всей ветки, а не по последнему коммиту."), document.Steps[1]);
        Assert.Null(document.Steps[0].Skip);
        Assert.Null(document.Steps[2].Description);
    }

    [Fact]
    public void Serialize_OfParsedFile_GivesSameText()
    {
        var text = Flow.ReplaceLineEndings("\n");

        Assert.Equal(text, FlowFile.Serialize(FlowFile.Parse(text)));
    }

    [Fact]
    public void Serialize_KeepsLineEndingsOfFile()
    {
        var text = Flow.ReplaceLineEndings("\r\n");

        Assert.Equal(text, FlowFile.Serialize(FlowFile.Parse(text), "\r\n"));
    }

    [Fact]
    public void Serialize_RenumbersStepsAndTheirPointsAfterReorder()
    {
        var document = FlowFile.Parse(Flow.ReplaceLineEndings("\n"));
        var reordered = document with { Steps = [document.Steps[1], document.Steps[0]] };

        var text = FlowFile.Serialize(reordered);

        Assert.Contains("## 1. Ревью\n\nисполнитель: reviewer\nвыход: вердикт по sha, записанный оркестратором\nпропуск: правка только в текстах\n\n1.1. Собрать дифф", text);
        Assert.Contains("## 2. Критерий\n\nисполнитель: оркестратор\nвыход: критерий закрытия в памяти\n\n2.1. Написать критерий до первой строчки кода.\n   2.1.1. Всё, что выходит", text);
        Assert.Contains("\n2.2. Вынести критерий", text);
        Assert.DoesNotContain("## 3.", text);
    }

    // Описание свободным текстом по форме кита: абзацы через пустую строку, списки «-», «1.» и пункты «N.M.».
    private const string FreeTextFlow = """
        # App — флоу

        ## 1. Реализация

        исполнитель: оркестратор
        выход: sha коммитов ветки

        Работа идёт шагами, каждый со своей проверкой.

        Проверки выбираются по тому, что затронуто:
        - код — тесты, линт и сборка;
        - вёрстка — ещё и e2e-прогон.

        Порядок:
        1. Прогнать тесты.
        2. Собрать фронт.

        1.1. Проверки, которых нет, назвать оператору.

        ## 2. Мерж

        исполнитель: оркестратор
        выход: sha в dev

        """;

    [Fact]
    public void Parse_KeepsFreeTextDescriptionWithParagraphsAndLists()
    {
        var document = FlowFile.Parse(FreeTextFlow.ReplaceLineEndings("\n"));

        Assert.Equal(
            "Работа идёт шагами, каждый со своей проверкой.\n\n" +
            "Проверки выбираются по тому, что затронуто:\n- код — тесты, линт и сборка;\n- вёрстка — ещё и e2e-прогон.\n\n" +
            "Порядок:\n1. Прогнать тесты.\n2. Собрать фронт.\n\n" +
            "1.1. Проверки, которых нет, назвать оператору.",
            document.Steps[0].Description);
    }

    [Fact]
    public void Serialize_OfParsedFreeTextFile_GivesSameText()
    {
        var text = FreeTextFlow.ReplaceLineEndings("\n");

        Assert.Equal(text, FlowFile.Serialize(FlowFile.Parse(text)));
    }

    [Fact]
    public void Serialize_AfterReorder_RenumbersOnlyPointsOfFreeTextDescription()
    {
        var document = FlowFile.Parse(FreeTextFlow.ReplaceLineEndings("\n"));
        var reordered = document with { Steps = [document.Steps[1], document.Steps[0]] };

        var moved = FlowFile.Parse(FlowFile.Serialize(reordered)).Steps[1].Description;

        Assert.Equal(document.Steps[0].Description!.Replace("1.1. Проверки", "2.1. Проверки"), moved);
    }

    [Fact]
    public void Serialize_NewStepWithoutDescriptionHasOnlyKeys()
    {
        var text = FlowFile.Serialize(new FlowDocument("# App — флоу", [new FlowStep("Мерж", "оркестратор", "sha в dev", "  ", null)]));

        Assert.Equal("# App — флоу\n\n## 1. Мерж\n\nисполнитель: оркестратор\nвыход: sha в dev\n", text);
    }

    [Fact]
    public void Parse_FileWithoutSteps_HasOnlyHeader()
    {
        var document = FlowFile.Parse("# App — флоу\n\n<!-- шаги пишет проект -->\n");

        Assert.Empty(document.Steps);
        Assert.Equal("# App — флоу\n\n<!-- шаги пишет проект -->", document.Header);
    }

    [Theory]
    [InlineData(" ", "оркестратор", "выход", FlowProblem.EmptyTitle)]
    [InlineData("Шаг", "", "выход", FlowProblem.EmptyExecutor)]
    [InlineData("Шаг", "оператор", " ", FlowProblem.EmptyOutput)]
    [InlineData("Шаг", "оператор", "две\nстроки", FlowProblem.LineBreak)]
    public void Validate_RejectsStepThatBreaksKitForm(string title, string executor, string output, FlowProblem problem)
    {
        var steps = new[]
        {
            new FlowStep("Первый", "оркестратор", "коммит", null, null),
            new FlowStep(title, executor, output, null, null),
        };

        Assert.Equal(new FlowRejection(2, problem), FlowFile.Validate(steps));
    }

    [Fact]
    public void Validate_AcceptsStepsInKitForm()
    {
        Assert.Null(FlowFile.Validate([new FlowStep("Шаг", "оркестратор", "коммит", null, "1.1. Сделать.")]));
    }
}
