using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class TrackerDescriptionTests
{
    private static readonly TrackerDescription Full = new(
        "YouTrack", "https://acme.youtrack.cloud", "PAY",
        "Ходим MCP-сервером youtrack.",
        "Задачи проекта PAY, назначенные на меня.",
        "Назначить на себя и перевести в «In Progress».",
        "Ничего: задачу закрывает мерж.",
        "В проект PAY, тип Task.");

    [Fact]
    public void Serialize_WritesKitForm()
    {
        var text = TrackerDescriptions.Serialize(Full with { Tracker = "youtrack" }, "Order Service");

        Assert.Equal(
            """
            # Order Service — трекер

            ## Где задачи

            трекер: YouTrack
            сервер: https://acme.youtrack.cloud
            проект: PAY

            Ходим MCP-сервером youtrack.

            ## Показ бэклога

            Задачи проекта PAY, назначенные на меня.

            ## Взятие задачи

            Назначить на себя и перевести в «In Progress».

            ## Задача закрыта

            Ничего: задачу закрывает мерж.

            ## Вынос записи бэклога

            В проект PAY, тип Task.

            """.ReplaceLineEndings("\n"),
            text);
    }

    /// <summary>Записанное панелью читается и её разбором, и разбором строк, которым панель читает трекер для «Бэклога».</summary>
    [Fact]
    public void Serialize_ThenParse_RoundTrips()
    {
        var multiline = Full with { Take = "Назначить на себя.\n\n- статус: In Progress\n- комментарий: взята" };
        var text = TrackerDescriptions.Serialize(multiline, "Order Service");

        Assert.Equal(multiline, TrackerDescriptions.Parse(text));
        Assert.Equal(new TrackerInfo(TrackerInfo.YouTrack, "YouTrack", "https://acme.youtrack.cloud", "PAY"), Tracker.Parse(text));
    }

    [Fact]
    public void Parse_KitWrittenFile_TakesLinesAndSections()
    {
        var description = TrackerDescriptions.Parse(
            """
            # Order Service — трекер

            ## Где задачи
            Трекер: GitHub
            сервер: https://github.com
            проект: acme/orders
            Ходим gh.

            ```
            ## не раздел
            ```

            ## Показ бэклога
            gh issue list --assignee @me

            ## Взятие задачи
            Метка in-progress.
            ## Задача закрыта
            Ничего.
            ## Вынос записи бэклога
            В acme/orders.
            """.Replace("\n", "\r\n"));

        Assert.Equal("GitHub", description.Tracker);
        Assert.Equal("https://github.com", description.Server);
        Assert.Equal("acme/orders", description.Project);
        Assert.Equal("Ходим gh.\n\n```\n## не раздел\n```", description.Where);
        Assert.Equal("gh issue list --assignee @me", description.Backlog);
        Assert.Equal("Метка in-progress.", description.Take);
        Assert.Equal("Ничего.", description.Closed);
        Assert.Equal("В acme/orders.", description.Move);
    }

    [Fact]
    public void Parse_NoKeys_LeavesLinesEmpty()
    {
        var description = TrackerDescriptions.Parse("# X — трекер\n\n## Где задачи\n\nХодим gh в acme/orders.\n");

        Assert.Equal("", description.Tracker);
        Assert.Equal("", description.Project);
        Assert.Equal("Ходим gh в acme/orders.", description.Where);
        Assert.Equal("", description.Move);
    }

    [Fact]
    public void Faults_Full_None()
    {
        Assert.Empty(TrackerDescriptions.Faults(Full));
    }

    [Theory]
    [InlineData("GitHub", "acme/orders")]
    [InlineData("gitlab", "acme/team/orders")]
    [InlineData("Jira", "PAY_2")]
    [InlineData("YouTrack", "pay2")]
    public void Faults_ProjectOfTable_Passes(string tracker, string project)
    {
        Assert.Empty(TrackerDescriptions.Faults(Full with { Tracker = tracker, Project = project }));
    }

    [Theory]
    [InlineData("GitHub", "orders")]
    [InlineData("GitLab", "orders")]
    [InlineData("Jira", "pay")]
    [InlineData("Jira", "P")]
    [InlineData("YouTrack", "2PAY")]
    public void Faults_ProjectOffPattern_NamesProject(string tracker, string project)
    {
        var faults = TrackerDescriptions.Faults(Full with { Tracker = tracker, Project = project });

        Assert.Equal(["project"], faults.Keys);
        Assert.Contains(tracker, faults["project"], StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("")]
    [InlineData("Redmine")]
    public void Faults_TrackerOffTable_NamesTracker(string tracker)
    {
        Assert.Contains("tracker", TrackerDescriptions.Faults(Full with { Tracker = tracker }).Keys);
    }

    [Theory]
    [InlineData("")]
    [InlineData("acme.youtrack.cloud")]
    [InlineData("https://user:secret@acme.youtrack.cloud")]
    [InlineData("https://acme.youtrack.cloud/?token=1")]
    public void Faults_BadServer_NamesServer(string server)
    {
        Assert.Equal(["server"], TrackerDescriptions.Faults(Full with { Server = server }).Keys);
    }

    /// <summary>Раздел из одного комментария кит считает пустым.</summary>
    [Fact]
    public void Faults_EmptySections_NamesEach()
    {
        var faults = TrackerDescriptions.Faults(Full with { Where = "  ", Closed = "<!-- потом -->" });

        Assert.Equal(["where", "closed"], faults.Keys);
    }

    /// <summary>«##» вне блока кода кит принял бы за раздел не из таблицы; в блоке кода — нет.</summary>
    [Fact]
    public void Faults_HeadingInSection_NamesSection()
    {
        var faults = TrackerDescriptions.Faults(Full with
        {
            Take = "Назначить на себя.\n## Статусы\nIn Progress",
            Move = "```\n## пример\n```",
        });

        Assert.Equal(["take"], faults.Keys);
    }

    [Fact]
    public void Changed_CountsLinesAndSections()
    {
        var after = Full with { Project = "CRM", Take = Full.Take + "\nМетка in-progress.", Move = Full.Move + "  \r\n" };

        Assert.Equal((1, 1), TrackerDescriptions.Changed(Full, after));
        Assert.Equal((0, 0), TrackerDescriptions.Changed(Full, Full));
    }
}
