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
        Assert.Equal("git.acme.local:8443/acme/orders", Tracker.Parse(Describe("трекер: GitHub\nсервер: https://git.acme.local:8443\nпроект: acme/orders")).GitHubRepo);
    }

    [Fact]
    public void Parse_YouTrackKeys_TakesServerAndProject()
    {
        var tracker = Tracker.Parse(Describe("Трекер: YouTrack\nСервер: https://acme.youtrack.cloud\nпроект: PAY_2"));

        Assert.Equal(new TrackerInfo(TrackerInfo.YouTrack, "YouTrack", "https://acme.youtrack.cloud", "PAY_2"), tracker);
        Assert.Null(tracker.GitHubRepo);
    }

    /// <summary>Облачную Jira панель читает своим клиентом (B-285): ключ проекта — как в таблице трекеров кита.</summary>
    [Fact]
    public void Parse_JiraKeys_TakesServerAndProject()
    {
        var tracker = Tracker.Parse(Describe("трекер: Jira\nсервер: https://acme.atlassian.net/\nпроект: PAY_2"));

        Assert.Equal(new TrackerInfo(TrackerInfo.Jira, "Jira", "https://acme.atlassian.net", "PAY_2"), tracker);
        Assert.Null(tracker.GitHubRepo);
    }

    [Theory]
    [InlineData("pay")]
    [InlineData("P")]
    [InlineData("1PAY")]
    [InlineData("PAY-1")]
    public void Parse_JiraProjectNotByTemplate_IsNoKeys(string project)
    {
        var tracker = Tracker.Parse(Describe($"трекер: Jira\nсервер: https://acme.atlassian.net\nпроект: {project}"));

        Assert.Equal(TrackerInfo.NoKeys, tracker.Kind);
        Assert.Equal(["проект"], tracker.Faults);
    }

    /// <summary>Строка «фильтр:» среди строк кита — отбор задач трекера (B-300); повтор — берётся первая, как в окне.</summary>
    [Fact]
    public void Parse_FilterLine_TakesFirstFilter()
    {
        var youTrack = Tracker.Parse(Describe(
            "трекер: YouTrack\nсервер: https://acme.youtrack.cloud\nпроект: PAY\nФильтр: State: {To Do}\nфильтр: tag: x"));
        var gitHub = Tracker.Parse(Describe("трекер: GitHub\nсервер: https://github.com\nпроект: acme/orders\nфильтр:"));

        Assert.Equal(new TrackerInfo(TrackerInfo.YouTrack, "YouTrack", "https://acme.youtrack.cloud", "PAY", Filter: "State: {To Do}"), youTrack);
        Assert.Null(gitHub.Filter);
    }

    [Theory]
    [InlineData("трекер: GitLab\nсервер: https://gitlab.com\nпроект: acme/orders", "GitLab")]
    [InlineData("трекер: Redmine\nсервер: http://redmine.acme.local:8080/tasks\nпроект: заказы", "Redmine")]
    public void Parse_OtherTracker_IsOtherWithItsName(string where, string name)
    {
        Assert.Equal(new TrackerInfo(TrackerInfo.Other, name), Tracker.Parse(Describe(where)));
    }

    /// <summary>Без трёх строк панель в прозе ничего не ищет — и адрес GitHub в словах не берёт (решение оператора на B-288).</summary>
    /// <summary>Красная строка называет, каких строк нет или какие записаны не так, — как на макете B-288.</summary>
    [Theory]
    [InlineData("GitHub Issues репозитория https://github.com/acme/orders, ходить через gh; номер — #37.", "трекер,сервер,проект")]
    [InlineData("трекер: GitHub\nсервер: https://github.com", "проект")]
    [InlineData("трекер: YouTrack", "сервер,проект")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект:", "проект")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект: acme/orders\nпроект: acme/other", "проект")]
    [InlineData("трекер: GitHub\n\nсервер: https://github.com\nпроект: acme/orders", "сервер,проект")]
    [InlineData("трекер: GitHub\nсервер: github.com\nпроект: acme/orders", "сервер")]
    [InlineData("трекер: GitHub\nсервер: https://bot:secret@github.com\nпроект: acme/orders", "сервер")]
    [InlineData("трекер: GitHub\nсервер: https://github.com/?token=1\nпроект: acme/orders", "сервер")]
    [InlineData("трекер: GitHub\nсервер: https://github.com\nпроект: orders", "проект")]
    [InlineData("трекер: YouTrack\nсервер: https://acme.youtrack.cloud\nпроект: 1PAY", "проект")]
    [InlineData("трекер: YouTrack\nсервер: https://acme.youtrack.cloud\nпроект: PAY-1", "проект")]
    [InlineData("трекер: Jira\nпроект: PAY", "сервер")]
    public void Parse_MissingOrMalformedKeys_IsNoKeysNamingThem(string where, string faults)
    {
        var tracker = Tracker.Parse(Describe(where));

        Assert.Equal(TrackerInfo.NoKeys, tracker.Kind);
        Assert.Equal(faults.Split(','), tracker.Faults);
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

        Assert.Equal(TrackerInfo.NoKeys, tracker.Kind);
    }

    [Fact]
    public void Parse_NoWhereSection_IsNoKeys()
    {
        var tracker = Tracker.Parse("# Трекер\n\n## Показ бэклога\nтрекер: GitHub\nсервер: https://github.com\nпроект: acme/orders\n");

        Assert.Equal(TrackerInfo.NoKeys, tracker.Kind);
    }
}
