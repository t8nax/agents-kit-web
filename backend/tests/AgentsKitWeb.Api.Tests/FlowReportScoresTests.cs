using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Reports;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowReportScoresTests
{
    private static readonly Requirement[] Requirements =
    [
        new("П1", "Проходимость", Priority.High, "Каждый исход куда-то ведёт", "…"),
        new("П5", "Проходимость", Priority.Medium, "Нужное дальше — выходом", "…"),
        new("С1", "Согласованность", Priority.High, "Флоу себе не противоречит", "…"),
        new("Я4", "Ясность", Priority.Low, "Во флоу только порядок работы", "…"),
    ];

    private static ReportFinding Finding(params string[] codes) => new("1", codes, "Мерж", [], "Почему.", "Что сделать.");

    [Fact]
    public void Of_WithoutFindings_AllRingsAreFullAndGreen()
    {
        var rings = FlowReportScores.Of(Requirements, []);

        Assert.Equal(
            [
                new RingScore("Проходимость", 100, "pass", 2, 2),
                new RingScore("Согласованность", 100, "pass", 1, 1),
                new RingScore("Ясность", 100, "pass", 1, 1),
            ],
            rings);
    }

    [Fact]
    public void Of_SubtractsByPriorityOfRequirement()
    {
        var rings = FlowReportScores.Of(Requirements, [Finding("П5"), Finding("Я4"), Finding("Я4")]);

        Assert.Equal(new RingScore("Проходимость", 93, "pass", 2, 1), rings[0]);
        // Две находки под одним требованием снимают дважды, но невыполненное требование одно.
        Assert.Equal(new RingScore("Ясность", 96, "pass", 1, 0), rings[2]);
    }

    [Fact]
    public void Of_FindingUnderTwoRequirements_SubtractsInBothRings()
    {
        var rings = FlowReportScores.Of(Requirements, [Finding("П1", "С1")]);

        Assert.Equal(85, rings[0].Score);
        Assert.Equal(85, rings[1].Score);
        Assert.Equal(100, rings[2].Score);
    }

    [Fact]
    public void Of_HighPriorityRingIsNeverGreen_AndLowScoreIsRed()
    {
        var one = FlowReportScores.Of(Requirements, [Finding("П1")]);
        Assert.Equal("avg", one[0].Band);

        var many = FlowReportScores.Of(Requirements, Enumerable.Repeat(Finding("П1"), 8).ToArray());
        Assert.Equal(0, many[0].Score);
        Assert.Equal("fail", many[0].Band);
    }

    [Fact]
    public void FlowErrors_CountsOnlyErrorsInFlowOfThisBase()
    {
        var snapshot = new HealthSnapshot(false, KitStatus.Ok,
        [
            new BaseHealth(@"D:\base", "App", BaseHealthStatus.Checked, null,
            [
                new HealthProblem("error", "local/me/flow/scenarios.md", "пункт сценария — не ссылка"),
                new HealthProblem("warning", "local/me/flow/stages/review.md", "этап не входит ни в один сценарий"),
                new HealthProblem("error", "local/me/agents/reviewer.md", "нет name"),
                new HealthProblem("error", "product.md", "перерасход"),
            ], []),
            new BaseHealth(@"D:\other", "Other", BaseHealthStatus.Checked, null,
                [new HealthProblem("error", "local/me/flow/scenarios.md", "…")], []),
        ], null);

        Assert.Equal(1, FlowReports.FlowErrors(snapshot, @"d:\BASE"));
        Assert.Equal(0, FlowReports.FlowErrors(snapshot, @"D:\missing"));
    }
}
