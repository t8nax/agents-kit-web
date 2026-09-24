using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowProposalsTests
{
    private static readonly FlowStage Review = new("Ревью", "reviewer", "вердикт по sha", null, "1. Собрать дифф.", Slug: "review");
    private static readonly FlowStage Merge = new("Мерж", "оркестратор", "sha в dev", null, null, Slug: "merge");
    private static readonly FlowStage Design = new("Дизайн", "designer", "макет", null, null, Slug: "design");

    private static readonly NamedFlow Big = new(
        "крупный", "много работы",
        [new FlowEntry("Дизайн"), new FlowEntry("Ревью"), new FlowEntry("Мерж", [new StageReturn("dev ушёл", "Ревью")])]);

    private static readonly NamedFlow Small = new("мелкий", "мало работы", [new FlowEntry("Ревью"), new FlowEntry("Мерж")]);

    private static readonly FlowStage[] Stages = [Review, Merge, Design];
    private static readonly NamedFlow[] Flows = [Big, Small];

    private const string Docs = "# Документация\n\nисполнитель: оркестратор\nвыход: раздел\n";

    [Fact]
    public void Take_AnswerWithoutBlocks_KeepsProposalAndChangesNothing()
    {
        var earlier = new FlowProposal([], [new StageChange(null, Parsed(Docs))]);

        var taken = FlowProposals.Take("Документация нужна в обоих сценариях?", Stages, Flows, earlier);

        Assert.Equal("Документация нужна в обоих сценариях?", taken.Said);
        Assert.Same(earlier, taken.Proposal);
        Assert.Null(taken.Changed);
        Assert.Null(taken.Error);
    }

    [Fact]
    public void Take_ReadsWordsNewStageAndRewrittenScenario()
    {
        var taken = FlowProposals.Take($"""
            Завёл документацию после мержа.

            === новый этап
            {Docs}
            === сценарий «мелкий»
            ## мелкий
            когда: мало работы
            1. [Ревью](stages/review.md)
            2. [Мерж](stages/merge.md)
            3. [Документация](stages/docs.md)
            """.ReplaceLineEndings("\n"), Stages, Flows, FlowProposal.Empty);

        Assert.Null(taken.Error);
        Assert.Equal("Завёл документацию после мержа.", taken.Said);
        Assert.Equal(new FlowChanged(1, 1), taken.Changed);
        var stage = Assert.Single(taken.Proposal.Stages);
        Assert.Null(stage.Of);
        Assert.Equal("Документация", stage.Stage!.Title);
        Assert.Null(stage.Stage.Slug);
        var scenario = Assert.Single(taken.Proposal.Scenarios);
        Assert.Equal("мелкий", scenario.Of);
        Assert.Equal(["Ревью", "Мерж", "Документация"], scenario.Flow!.Entries.Select(e => e.Stage));
    }

    [Fact]
    public void Take_RewrittenStageKeepsSlugAndRenameFollowsInScenarios()
    {
        var taken = FlowProposals.Take(
            "=== этап «Ревью»\n# Проверка\n\nисполнитель: reviewer\nвыход: вердикт\n", Stages, Flows, FlowProposal.Empty);

        Assert.Null(taken.Error);
        var change = Assert.Single(taken.Proposal.Stages);
        Assert.Equal("Ревью", change.Of);
        Assert.Equal("review", change.Stage!.Slug);
        // Сценарии, которых агент не трогал, идут за переименованным этапом — и пункт, и возврат.
        var (_, flows) = FlowProposals.Apply(Stages, Flows, taken.Proposal);
        Assert.Equal(["Дизайн", "Проверка", "Мерж"], flows[0].Entries.Select(e => e.Stage));
        Assert.Equal("Проверка", flows[0].Entries[2].Returns![0].Stage);
    }

    [Fact]
    public void Take_DeletesStageAndScenario()
    {
        var taken = FlowProposals.Take("""
            Убрал дизайн.
            === удалить этап «Дизайн»
            === сценарий «крупный»
            ## крупный
            когда: много работы
            1. [Ревью](stages/review.md)
            2. [Мерж](stages/merge.md)
            === удалить сценарий «мелкий»
            """.ReplaceLineEndings("\n"), Stages, Flows, FlowProposal.Empty);

        Assert.Null(taken.Error);
        Assert.Equal(new FlowChanged(2, 1), taken.Changed);
        Assert.Equal(new StageChange("Дизайн", null), Assert.Single(taken.Proposal.Stages));
        var (stages, flows) = FlowProposals.Apply(Stages, Flows, taken.Proposal);
        Assert.Equal(["Ревью", "Мерж"], stages.Select(s => s.Title));
        Assert.Equal(["крупный"], flows.Select(f => f.Name));
    }

    [Fact]
    public void Take_SecondAnswerUpdatesEarlierChangeByItsCurrentName()
    {
        var first = FlowProposals.Take(
            "=== этап «Ревью»\n# Проверка\n\nисполнитель: reviewer\nвыход: вердикт\n", Stages, Flows, FlowProposal.Empty);

        var second = FlowProposals.Take(
            "=== этап «Проверка»\n# Проверка\n\nисполнитель: reviewer\nвыход: вердикт и тесты\n", Stages, Flows, first.Proposal);

        Assert.Null(second.Error);
        // Правка одна на этап: вторая заменила первую, а «было» у неё всё то же — этап на экране.
        var change = Assert.Single(second.Proposal.Stages);
        Assert.Equal("Ревью", change.Of);
        Assert.Equal("вердикт и тесты", change.Stage!.Output);
        Assert.Equal(new FlowChanged(0, 1), second.Changed);
    }

    [Fact]
    public void Take_NewStageDeletedInSameConversation_LeavesProposal()
    {
        var first = FlowProposals.Take($"=== новый этап\n{Docs}", Stages, Flows, FlowProposal.Empty);

        var second = FlowProposals.Take("=== удалить этап «Документация»\n", Stages, Flows, first.Proposal);

        Assert.Null(second.Error);
        Assert.Empty(second.Proposal.Stages);
    }

    [Fact]
    public void Take_StripsCommonFenceAroundBlocks()
    {
        var taken = FlowProposals.Take($"Готово.\n```markdown\n=== новый этап\n{Docs}```\n", Stages, Flows, FlowProposal.Empty);

        Assert.Null(taken.Error);
        Assert.Equal("Готово.", taken.Said);
        Assert.Equal("раздел", taken.Proposal.Stages[0].Stage!.Output);
    }

    [Theory]
    [InlineData("=== этап «Сборка»\n# Сборка\n\nисполнитель: оператор\nвыход: есть\n", "Чудо-Юдо предложил правку этапа «Сборка», которого во флоу нет")]
    [InlineData("=== удалить сценарий «средний»\n", "Чудо-Юдо предложил правку сценария «средний», которого во флоу нет")]
    [InlineData("=== Ревью\n# Ревью\n\nисполнитель: оператор\nвыход: есть\n", "Чудо-Юдо вернул блок с пометкой, которую панель не знает: «=== Ревью»")]
    [InlineData("=== этап «Ревью»\n# Ревью\n\nисполнитель: оператор\n", "Этап «Ревью» вернулся не в форме кита: не указан выход")]
    [InlineData("=== этап «Ревью»\n# Ревью\n\nисполнитель: оператор\nвыход: есть\nвозврат: красное\n", "Этап «Ревью» вернулся не в форме кита: строка 5: ключ вне перечня «возврат: красное»")]
    [InlineData("=== сценарий «мелкий»\n## мелкий\nкогда: мало\n1. Ревью\n", "Сценарий «мелкий» вернулся не в форме кита: строка 3: «1. Ревью»")]
    [InlineData("=== новый сценарий\n## средний\nкогда: средне\n1. [Ревью](stages/review.md)\n## ещё\n", "Чудо-Юдо вернул под пометкой «=== новый сценарий» не один раздел сценария «## Имя»")]
    // Удалённый этап остался в сценарии: запись флоу такое не примет, и правки не копятся.
    [InlineData("=== удалить этап «Мерж»\n", "С правками Чудо-Юдо флоу не сойдётся с правилами кита: пункт сценария ссылается на этап, которого нет (сценарий «крупный», этап «Мерж»)")]
    [InlineData("=== новый этап\n# Мерж\n\nисполнитель: оператор\nвыход: есть\n", "С правками Чудо-Юдо флоу не сойдётся с правилами кита: два этапа с одним названием (этап «Мерж»)")]
    public void Take_RejectsWhatWriteWouldNotAccept(string answer, string expected)
    {
        var earlier = new FlowProposal([], [new StageChange(null, Parsed(Docs))]);

        var taken = FlowProposals.Take(answer, Stages, Flows, earlier);

        Assert.Equal(expected, taken.Error);
        Assert.Same(earlier, taken.Proposal);
    }

    [Fact]
    public void Rebase_DropsWhatScreenAlreadyHolds()
    {
        var renamed = Review with { Title = "Проверка" };
        var docs = Parsed(Docs);
        var proposal = new FlowProposal(
            [new ScenarioChange("мелкий", Small with { When = "совсем мало" }), new ScenarioChange("крупный", null)],
            [new StageChange("Ревью", renamed), new StageChange(null, docs), new StageChange("Дизайн", null)]);

        // Оператор записал переименование и новый этап; дизайна и крупного сценария на экране уже нет.
        var rebased = FlowProposals.Rebase(
            [renamed, Merge, docs with { Slug = "docs" }], [Small], proposal);

        Assert.Equal([new ScenarioChange("мелкий", Small with { When = "совсем мало" })], rebased.Scenarios);
        Assert.Empty(rebased.Stages);
    }

    [Fact]
    public void Rebase_WrittenScenarioMatchesByKeyLikeKit()
    {
        // Агент назвал этап в пункте «ревью», а записанный и перечитанный сценарий зовёт его по файлу — «Ревью».
        var proposed = new NamedFlow("мелкий", "мало работы", [new FlowEntry("ревью"), new FlowEntry("Мерж ")]);

        var rebased = FlowProposals.Rebase(Stages, [Big, Small], new FlowProposal([new ScenarioChange("мелкий", proposed)], []));

        Assert.Empty(rebased.Scenarios);
    }

    [Fact]
    public void Input_BaseWithTwoStagesOfOneTitle_StillGivesFlow()
    {
        // Два этапа с одним названием бывают в базе, поправленной руками: начало переписки на них не падает.
        var input = FlowRewriteEndpoints.Input("Поправь ревью", [Review, Review with { Slug = "review-2" }], [Small], [], []);

        Assert.Contains("1. [Ревью](stages/review.md)", input);
    }

    [Fact]
    public void Input_TaskOfUnknownScenario_LeavesNewOnesOpen()
    {
        var input = FlowRewriteEndpoints.Input("Заведи этап", Stages, Flows, [new FlowTask("B-7", null)], []);

        Assert.Contains("- B-7: сценарий не узнан — панель не запишет ни одного из нынешних сценариев и этапов, а новые заводить можно", input);
    }

    private static FlowStage Parsed(string text) => FlowFolder.ParseStage(text, "") with { Slug = null };
}
