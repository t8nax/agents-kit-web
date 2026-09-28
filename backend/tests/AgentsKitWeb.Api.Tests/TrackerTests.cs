using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class TrackerTests
{
    private static string Describe(string where) => $"""
        # Order Service — трекер

        ## Где задачи
        {where}

        ## Показ бэклога
        Открытые задачи, назначенные на меня: https://github.com/acme/other/issues

        ## Взятие задачи
        Назначить на себя.
        """;

    [Theory]
    [InlineData("GitHub Issues репозитория https://github.com/acme/orders, ходить через gh; номер — #37.", "acme/orders")]
    [InlineData("Задачи — github.com/acme/orders-tasks.", "acme/orders-tasks")]
    [InlineData("Клон: git@github.com:acme/orders.git", "acme/orders")]
    [InlineData("Задачи на https://www.github.com/acme/orders/issues", "acme/orders")]
    [InlineData("Доска https://github.com/orgs/acme/projects/3, задачи в https://github.com/acme/orders/issues", "acme/orders")]
    public void Parse_TakesRepositoryFromWhereSection(string where, string repo)
    {
        var tracker = Tracker.Parse(Describe(where));

        Assert.Equal(new TrackerInfo(TrackerInfo.GitHub, repo), tracker);
    }

    [Theory]
    [InlineData("GitHub Issues, ходить через gh; номер — #37.")]
    [InlineData("GitHub Issues через API https://api.github.com/repos/acme/orders/issues.")]
    [InlineData("GitHub, заметки в https://gist.github.com/acme/abc123.")]
    public void Parse_GitHubWithoutRepositoryAddress_IsNoAddress(string where)
    {
        var tracker = Tracker.Parse(Describe(where));

        Assert.Equal(new TrackerInfo(TrackerInfo.NoAddress), tracker);
    }

    [Fact]
    public void Parse_OtherTracker_IsNotGitHub()
    {
        var tracker = Tracker.Parse(Describe("Jira, проект PAY на https://acme.atlassian.net, MCP-сервер atlassian; номер — PAY-7."));

        Assert.Equal(new TrackerInfo(TrackerInfo.NotGitHub), tracker);
    }

    [Fact]
    public void Parse_AddressInCommentOrOtherSection_IsNotTaken()
    {
        var tracker = Tracker.Parse("""
            # Трекер

            ## Где задачи
            GitHub Issues через gh.
            <!-- прежний: https://github.com/acme/old -->

            ## Показ бэклога
            ```
            ## Где задачи
            https://github.com/acme/in-code
            ```
            """);

        Assert.Equal(new TrackerInfo(TrackerInfo.NoAddress), tracker);
    }

    [Fact]
    public void Parse_NoWhereSection_IsNotGitHub()
    {
        var tracker = Tracker.Parse("# Трекер\n\n## Показ бэклога\nhttps://github.com/acme/orders\n");

        Assert.Equal(new TrackerInfo(TrackerInfo.NotGitHub), tracker);
    }
}
