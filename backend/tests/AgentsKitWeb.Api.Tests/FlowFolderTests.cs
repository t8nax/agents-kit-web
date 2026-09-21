using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowFolderTests
{
    private const string List = """
        # App — флоу

        Задачу из бэклога брать по наименьшему номеру.

        ## полный
        когда: новая возможность
        1. [Ветка](stages/branch.md)
        2. [Реализация](stages/implementation.md)
        3. [Ревью](stages/review.md)
           - возврат: замечания — стадия «Реализация»

        ## мелкий
        когда: правка в одном месте
        1. [Реализация](stages/implementation.md)
        2. [Ревью](stages/review.md)

        """;

    private static readonly Dictionary<string, string> Titles = new()
    {
        ["branch"] = "Ветка",
        ["implementation"] = "Реализация",
        ["review"] = "Ревью",
    };

    [Fact]
    public void ParseList_ReadsIntroFlowsWhenStagesAndReturnsPerFlow()
    {
        var (intro, flows, unread) = FlowFolder.ParseList(List, Titles);

        Assert.Equal("# App — флоу\n\nЗадачу из бэклога брать по наименьшему номеру.", intro);
        Assert.Empty(unread);
        Assert.Equal(["полный", "мелкий"], flows.Select(f => f.Name));
        Assert.Equal("новая возможность", flows[0].When);
        Assert.Equal(["Ветка", "Реализация", "Ревью"], flows[0].Entries.Select(e => e.Stage));
        Assert.Equal(new StageReturn("замечания", "Реализация"), Assert.Single(FlowFolder.Returns(flows[0].Entries[2])));
        // У той же стадии в другом флоу возвратов нет: их пишет флоу, а не стадия.
        Assert.Empty(FlowFolder.Returns(flows[1].Entries[1]));
    }

    [Fact]
    public void ParseList_TakesStageTitleFromItsFileNotFromLinkText()
    {
        var (_, flows, _) = FlowFolder.ParseList("## полный\n1. [Старое имя](stages/review.md)\n2. [Нет файла](stages/gone.md)\n", Titles);

        Assert.Equal(["Ревью", "Нет файла"], flows[0].Entries.Select(e => e.Stage));
    }

    [Fact]
    public void ParseList_NamesLinesNotInKitFormInsteadOfDroppingThem()
    {
        var (_, flows, unread) = FlowFolder.ParseList("""
            ## полный
            когда: новая возможность
            1. [Ветка](stages/branch.md)
            2. Ревью
            - возврат: замечания — стадия «Ветка»
            3. [Сборка](build.md)
            Просто заметка.
            """, Titles);

        Assert.Equal(["Ветка"], flows[0].Entries.Select(e => e.Stage));
        Assert.Equal(
            ["строка 4: «2. Ревью»", "строка 5: «- возврат: замечания — стадия «Ветка»»", "строка 6: «3. [Сборка](build.md)»", "строка 7: «Просто заметка.»"],
            unread);
    }

    [Fact]
    public void ParseList_AcceptsWhatKitCheckAccepts()
    {
        var (_, flows, unread) = FlowFolder.ParseList("""
            ## полный
              когда : новая возможность
            1. [Ветка](stages/branch.md)
            2. [Ревью](stages/review.md)
               - возврат : замечания — стадия «Ветка»
            """, Titles);

        Assert.Empty(unread);
        Assert.Equal("новая возможность", flows[0].When);
        Assert.Equal(new StageReturn("замечания", "Ветка"), Assert.Single(flows[0].Entries[1].Returns!));
    }

    [Fact]
    public void ReadStage_UnknownKeyRightUnderHeadingIsNamedAndKeysAfterItAreRead()
    {
        var (stage, unread) = FlowFolder.ReadStage("# X\n\nавтор: y\nисполнитель: z\nвыход : w\n\nОписание: с двоеточием.\n", "x");

        Assert.Equal(["строка 3: ключ вне перечня «автор: y»"], unread);
        Assert.Equal(("z", "w", "Описание: с двоеточием."), (stage.Executor, stage.Output, stage.Description));
    }

    [Fact]
    public void ReadStage_NamesTextBeforeHeadingKeyOutsideListAndRepeatedKey()
    {
        var (stage, unread) = FlowFolder.ReadStage("""
            заметка сверху
            # Ревью
            исполнитель: reviewer
            выход: вердикт
            выход: второй
            возврат: замечания — стадия «Реализация»

            Описание.
            """, "review");

        // Повтор ключа кит берёт последним — так и панель, но запись оставит одну строку.
        Assert.Equal("второй", stage.Output);
        Assert.Equal(
            ["строка 1: «заметка сверху»", "строка 5: ключ «выход» второй раз", "строка 6: ключ вне перечня «возврат: замечания — стадия «Реализация»»"],
            unread);
        Assert.Equal(["нет заголовка «# Название»"], FlowFolder.ReadStage("", "x").Unread);
        Assert.Empty(FlowFolder.ReadStage("# Ветка\n\nисполнитель: оркестратор\nвыход: ветка\n\nОписание.\n", "branch").Unread);
    }

    [Fact]
    public void SerializeList_RoundTripsKitForm()
    {
        var (intro, flows, unread) = FlowFolder.ParseList(List, Titles);
        var slugs = Titles.ToDictionary(p => FlowFolder.Key(p.Value), p => p.Key);

        Assert.Equal(List.ReplaceLineEndings("\n"), FlowFolder.SerializeList(intro, flows, slugs));
    }

    [Fact]
    public void SerializeList_KeepsIntroAsInFileWithTrailingSpaces()
    {
        const string text = "# App — флоу\n\nПервая строка  \nс переносом.\n\n## полный\n1. [Ветка](stages/branch.md)\n";
        var (intro, flows, _) = FlowFolder.ParseList(text, Titles);

        Assert.Equal(text, FlowFolder.SerializeList(intro, flows, new Dictionary<string, string> { ["ветка"] = "branch" }));
    }

    [Fact]
    public void SerializeList_SingleFlowWithoutWhen_HasNoWhenLine()
    {
        var text = FlowFolder.SerializeList(
            "# App — флоу",
            [new NamedFlow("полный", null, [new FlowEntry("Ветка")])],
            new Dictionary<string, string> { ["ветка"] = "branch" },
            "\r\n");

        Assert.Equal("# App — флоу\r\n\r\n## полный\r\n1. [Ветка](stages/branch.md)\r\n", text);
    }

    [Fact]
    public void ParseStage_ReadsTitleKeysAndDescription()
    {
        var stage = FlowFolder.ParseStage("""
            # Реализация

            исполнитель: оркестратор
            помощники: scout, check-runner
            выход: sha коммитов
            пропуск: правка только в текстах

            - Вести работу шагами.
              1. Первый.

            Второй абзац.
            """, "implementation");

        Assert.Equal(
            new FlowStage(
                "Реализация",
                "оркестратор",
                "sha коммитов",
                "правка только в текстах",
                "- Вести работу шагами.\n  1. Первый.\n\nВторой абзац.",
                ["scout", "check-runner"],
                "implementation"),
            stage);
    }

    [Fact]
    public void SerializeStage_RoundTripsKitForm()
    {
        const string text = "# Ревью\n\nисполнитель: code-reviewer\nвыход: вердикт по sha\nпропуск: правка не трогает код\n\n1. Собрать дифф.\n   1.1. Всей ветки.\n";

        Assert.Equal(text, FlowFolder.SerializeStage(FlowFolder.ParseStage(text, "review")));
    }

    [Fact]
    public void SerializeStage_WithoutDescription_EndsAfterKeys()
    {
        Assert.Equal(
            "# Ветка\n\nисполнитель: оркестратор\nвыход: имя ветки\n",
            FlowFolder.SerializeStage(new FlowStage("Ветка", "оркестратор", "имя ветки", null, null)));
    }

    public static TheoryData<string, string?, string?> Broken => new()
    {
        { "stage-empty-output", null, "Ревью" },
        { "stage-bad-title", null, "Ревью [черновик]" },
        { "stage-duplicate-title", null, "ревью " },
        { "helpers-not-orchestrator", null, "Ревью" },
        { "flow-duplicate-name", " Полный", null },
        { "flow-without-when", "мелкий", null },
        { "flow-without-stages", "мелкий", null },
        { "stage-unknown", "полный", "Мерж" },
        { "stage-twice", "полный", "Ветка" },
        { "return-without-condition", "полный", "Ревью" },
        { "return-unknown-stage", "мелкий", "Ревью" },
        { "return-stage-not-earlier", "полный", "Ветка" },
        { "line-break", "полный", null },
    };

    [Theory]
    [MemberData(nameof(Broken))]
    public void Validate_NamesWhatKitWouldCallBroken(string problem, string? flow, string? stage)
    {
        var stages = new List<FlowStage>
        {
            new("Ветка", "оркестратор", "ветка", null, null),
            new("Ревью", "code-reviewer", "вердикт", null, null),
        };
        var full = new NamedFlow("полный", "новая возможность", [new FlowEntry("Ветка"), new FlowEntry("Ревью")]);
        var small = new NamedFlow("мелкий", "правка в одном месте", [new FlowEntry("Ревью")]);
        List<NamedFlow> flows = [full, small];

        switch (problem)
        {
            case "stage-empty-output": stages[1] = stages[1] with { Output = " " }; break;
            case "stage-bad-title": stages.Add(new FlowStage("Ревью [черновик]", "оператор", "ок", null, null)); break;
            case "stage-duplicate-title": stages.Add(new FlowStage("ревью ", "оператор", "ок", null, null)); break;
            case "helpers-not-orchestrator": stages[1] = stages[1] with { Helpers = ["scout"] }; break;
            case "flow-duplicate-name": flows.Add(full with { Name = " Полный" }); break;
            case "flow-without-when": flows[1] = small with { When = " " }; break;
            case "flow-without-stages": flows[1] = small with { Entries = [] }; break;
            case "stage-unknown": flows[0] = full with { Entries = [.. full.Entries, new FlowEntry("Мерж")] }; break;
            case "stage-twice": flows[0] = full with { Entries = [.. full.Entries, new FlowEntry("Ветка")] }; break;
            case "return-without-condition":
                flows[0] = full with { Entries = [full.Entries[0], new FlowEntry("Ревью", [new StageReturn(" ", "Ветка")])] };
                break;
            case "return-unknown-stage":
                // Ветки во флоу «мелкий» нет: возврат ведёт только к стадии своего флоу.
                flows[1] = small with { Entries = [new FlowEntry("Ревью", [new StageReturn("замечания", "Ветка")])] };
                break;
            case "return-stage-not-earlier":
                flows[0] = full with { Entries = [new FlowEntry("Ветка", [new StageReturn("замечания", "Ревью")]), full.Entries[1]] };
                break;
            case "line-break": flows[0] = full with { When = "две\nстроки" }; break;
        }

        Assert.Equal(new FlowFolderRejection(problem, flow, stage), FlowFolder.Validate(stages, flows));
    }

    [Fact]
    public void Validate_SingleFlowWithoutWhenAndStageOutsideFlows_AreFine()
    {
        Assert.Null(FlowFolder.Validate(
            [new FlowStage("Ветка", "оркестратор", "ветка", null, null), new FlowStage("Запас", "оператор", "ок", null, null)],
            [new NamedFlow("полный", null, [new FlowEntry("ветка")])]));
    }

    [Fact]
    public void Key_LikeKitCheck_CollapsesSpacesAndIgnoresCase()
    {
        Assert.Equal(FlowFolder.Key("код ревью"), FlowFolder.Key(" Код   ревью "));
        Assert.NotEqual(FlowFolder.Key("код ревью"), FlowFolder.Key("кодревью"));
    }

    [Fact]
    public void NewSlug_TransliteratesAndAvoidsTaken()
    {
        Assert.Equal("fiksatsiya-znaniya", FlowFolder.NewSlug("Фиксация знания", []));
        Assert.Equal("review-2", FlowFolder.NewSlug("Review", ["review"]));
        Assert.Equal("stage", FlowFolder.NewSlug("«»", []));
    }

    [Fact]
    public void Fingerprint_ChangesWithAnyFileAndIgnoresOrder()
    {
        (string, byte[]) a = ("flow/flow.md", [1]);
        (string, byte[]) b = ("flow/stages/x.md", [2]);

        Assert.Equal(FlowFolder.Fingerprint([a, b]), FlowFolder.Fingerprint([b, a]));
        Assert.NotEqual(FlowFolder.Fingerprint([a, b]), FlowFolder.Fingerprint([a, ("flow/stages/x.md", [3])]));
    }
}
