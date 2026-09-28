using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class TrackerTests
{
    private static string Describe(string where) => $"""
        # Order Service — трекер

        ## Где задачи

        {where}

        ## Показ бэклога
        трекер: GitHub
        сервер: https://github.com
        проект: acme/other

        ## Взятие задачи
        Назначить на себя.
        """;

    [Fact]
    public void Parse_GitHubKeys_TakesServerAndProject()
    {
        var tracker = Tracker.Parse(Describe("трекер: GitHub\nсервер: https://github.com/\nпроект: acme/orders.api\n\nХодим gh."));

        Assert.Equal(new TrackerInfo(TrackerInfo.GitHub, "GitHub", "https://github.com", "acme/orders.api"), tracker);
        Assert.Equal("acme/orders.api", tracker.GitHubRepo);
    }

    /// <summary>У GitHub Enterprise gh называет репозиторий с хостом.</summary>
    [Fact]
    public void Parse_GitHubEnterprise_RepoCarriesHost()
    {
        var tracker = Tracker.Parse(Describe("трекер: github\nсервер: https://git.acme.local\nпроект: acme/orders"));

        Assert.Equal(TrackerInfo.GitHub, tracker.Kind);
        Assert.Equal("git.acme.local/acme/orders", tracker.GitHubRepo);
    }

    [Fact]
    public void Parse_YouTrackKeys_TakesServerAndProject()
    {
        var tracker = Tracker.Parse(Describe("Трекер: YouTrack\nСервер: https://acme.youtrack.cloud\nпроект: PAY_2"));

        Assert.Equal(new TrackerInfo(TrackerInfo.YouTrack, "YouTrack", "https://acme.youtrack.cloud", "PAY_2"), tracker);
        Assert.Null(tracker.GitHubRepo);
    }

    [Theory]
    [InlineData("трекер: Jira\nсервер: https://acme.atlassian.net\nпроект: PAY", "Jira")]
    [InlineData("трекер: Redmine\nсервер: http://redmine.acme.local:8080/tasks\nпроект: заказы", "Redmine")]
    public void Parse_OtherTracker_IsOtherWithItsName(string where, string name)
    {
        Assert.Equal(new TrackerInfo(TrackerInfo.Other, name), Tracker.Parse(Describe(where)));
    }

    /// <summary>Без трёх строк панель в прозе ничего не ищет — и адрес GitHub в словах не берёт (решение оператора на B-288).</summary>
    [Theory]
    [InlineData("GitHub Issues репозитория https://github.com/acme/orders, ходить через gh; номер — #37.")]
    [InlineData("трекер: GitHub\nсервер: https://github.com")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект:")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект: acme/orders\nпроект: acme/other")]
    [InlineData("трекер: GitHub\n\nсервер: https://github.com\nпроект: acme/orders")]
    [InlineData("трекер: GitHub\nсервер: github.com\nпроект: acme/orders")]
    [InlineData("трекер: GitHub\nсервер: https://bot:secret@github.com\nпроект: acme/orders")]
    [InlineData("трекер: GitHub\nсервер: https://github.com/?token=1\nпроект: acme/orders")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект: orders")]
    [InlineData("трекер: YouTrack\nсервер: https://acme.youtrack.cloud\nпроект: 1PAY")]
    [InlineData("трекер: YouTrack\nсервер: https://acme.youtrack.cloud\nпроект: PAY-1")]
    public void Parse_MissingOrMalformedKeys_IsNoKeys(string where)
    {
        Assert.Equal(new TrackerInfo(TrackerInfo.NoKeys), Tracker.Parse(Describe(where)));
    }

    [Fact]
    public void Parse_KeysInCommentOrCodeOrOtherSection_AreNotTaken()
    {
        var tracker = Tracker.Parse("""
            # Трекер

            ## Где задачи
            <!-- трекер: GitHub
            сервер: https://github.com
            проект: acme/old -->
            Словами.

            ## Показ бэклога
            ```
            ## Где задачи
            трекер: GitHub
            ```
            """);

        Assert.Equal(new TrackerInfo(TrackerInfo.NoKeys), tracker);
    }

    [Fact]
    public void Parse_NoWhereSection_IsNoKeys()
    {
        var tracker = Tracker.Parse("# Трекер\n\n## Показ бэклога\nтрекер: GitHub\nсервер: https://github.com\nпроект: acme/orders\n");

        Assert.Equal(new TrackerInfo(TrackerInfo.NoKeys), tracker);
    }
}
