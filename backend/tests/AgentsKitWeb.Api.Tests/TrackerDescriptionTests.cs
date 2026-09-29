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
            """.ReplaceLineEndings("\r\n"));

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

    /// <summary>
    /// Строки вида «слово: значение» в начале раздела, кроме трёх ключей, — слова раздела: проза с адресом (в нём
    /// всегда есть двоеточие) и «доска: …» не стираются записью описания (ревью B-293).
    /// </summary>
    [Fact]
    public void Parse_OtherPairsAtStart_StayInWhere()
    {
        var prose = TrackerDescriptions.Parse(
            "## Где задачи\nGitHub Issues репозитория https://github.com/sandbox/tracker, ходить программой gh.\n");
        var board = TrackerDescriptions.Parse(
            "## Где задачи\n\nтрекер: Jira\nдоска: PAY-доска\nсервер: https://acme.atlassian.net\nпроект: PAY\n\nХодим MCP.\n");

        Assert.Equal("GitHub Issues репозитория https://github.com/sandbox/tracker, ходить программой gh.", prose.Where);
        Assert.Equal("", prose.Server);
        Assert.Equal(("Jira", "https://acme.atlassian.net", "PAY"), (board.Tracker, board.Server, board.Project));
        Assert.Equal("доска: PAY-доска\n\nХодим MCP.", board.Where);
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

    /// <summary>Незакрытая ограда кода спрятала бы от сверки кита все разделы ниже.</summary>
    [Fact]
    public void Faults_UnclosedFence_NamesSection()
    {
        Assert.Equal(["backlog"], TrackerDescriptions.Faults(Full with { Backlog = "Пример:\n```\ngh issue list" }).Keys);
        Assert.Empty(TrackerDescriptions.Faults(Full with { Backlog = "Пример:\n```\ngh issue list\n```" }));
    }

    [Fact]
    public void Frame_TakesHeaderIntroAndForeignSections()
    {
        var frame = TrackerDescriptions.Frame(
            "```\n# в коде\n```\n# Заказы — трекер\nВступление.\n\n## Где задачи\n\nтрекер: GitHub\n\n## Свой\nзаметки\n```\n## в коде\n```\n## Показ бэклога\nмои\n");

        Assert.Equal("# Заказы — трекер", frame.Header);
        Assert.Equal("```\n# в коде\n```\nВступление.", frame.Intro);
        Assert.Equal("## Свой\nзаметки\n```\n## в коде\n```", frame.Extra);
    }

    [Fact]
    public void Changed_CountsLinesAndSections()
    {
        var after = Full with { Project = "CRM", Take = Full.Take + "\nМетка in-progress.", Move = Full.Move + "  \r\n" };

        Assert.Equal((1, 1), TrackerDescriptions.Changed(Full, after));
        Assert.Equal((0, 0), TrackerDescriptions.Changed(Full, Full));
        Assert.Equal((1, 0), TrackerDescriptions.Changed(Full, Full with { Query = "State: {To Do}" }));
    }

    /// <summary>
    /// Запрос — строка «запрос:» сразу за тремя строками кита (B-300): записанное читается и окном, и разбором «Бэклога»;
    /// пустой запрос строки не пишет.
    /// </summary>
    [Fact]
    public void Query_WrittenAfterKitLines_AndRoundTrips()
    {
        var filtered = Full with { Query = " State: {To Do} " };
        var text = TrackerDescriptions.Serialize(filtered, "Order Service");

        Assert.Contains("проект: PAY\nзапрос: State: {To Do}\n\nХодим MCP-сервером youtrack.", text);
        Assert.Equal(filtered with { Query = "State: {To Do}" }, TrackerDescriptions.Parse(text));
        Assert.Equal("State: {To Do}", Tracker.Parse(text).Query);
        Assert.DoesNotContain("запрос:", TrackerDescriptions.Serialize(Full, "Order Service"));
    }

    [Fact]
    public void Faults_QueryOnSeveralLines_IsNamed()
    {
        Assert.Equal("Значение — одна строка", TrackerDescriptions.Faults(Full with { Query = "State: {To Do}\ntag: x" })["query"]);
        Assert.DoesNotContain("query", TrackerDescriptions.Faults(Full with { Query = "State: {To Do}" }).Keys);
    }
}
