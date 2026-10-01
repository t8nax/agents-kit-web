using System.Diagnostics;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class GhIssuesTests
{
    /// <summary>
    /// «Открытые» держит ключ gh, а отбора по исполнителю нет — видны и чужие, и ничьи задачи (AKW-17). Задач
    /// спрашивается на одну больше сотни: так видно, что есть ещё.
    /// </summary>
    [Fact]
    public void StartInfo_AsksAllOpenIssuesWithAssigneesWithoutWindow()
    {
        var startInfo = GhIssues.StartInfo("acme/orders");

        Assert.Equal("gh", startInfo.FileName);
        Assert.Equal(
            ["issue", "list", "--repo", "acme/orders", "--state", "open", "--limit", "101", "--json", "number,title,url,labels,assignees"],
            startInfo.ArgumentList);
        Assert.True(startInfo.CreateNoWindow);
        Assert.False(startInfo.UseShellExecute);
        Assert.Equal("1", startInfo.Environment["GH_PROMPT_DISABLED"]);
    }

    /// <summary>Строка отбора описания уходит поиском gh вдобавок к состоянию (B-300).</summary>
    [Fact]
    public void StartInfo_WithFilter_AddsSearch()
    {
        Assert.Equal(
            ["issue", "list", "--repo", "acme/orders", "--state", "open", "--search", "(assignee:@me label:bug)",
                "--limit", "101", "--json", "number,title,url,labels,assignees"],
            GhIssues.StartInfo("acme/orders", " assignee:@me label:bug ").ArgumentList);
        Assert.DoesNotContain("--search", GhIssues.StartInfo("acme/orders", " ").ArgumentList);
    }

    /// <summary>Кем вошла gh, спрашивается на сервере репозитория: у GitHub Enterprise вход у неё свой.</summary>
    [Fact]
    public void UserStartInfo_AsksLoginOnServerOfRepository()
    {
        Assert.Equal(["api", "user", "--jq", ".login"], GhIssues.UserStartInfo("acme/orders").ArgumentList);
        Assert.Equal(
            ["api", "user", "--jq", ".login", "--hostname", "git.acme.local:8443"],
            GhIssues.UserStartInfo("git.acme.local:8443/acme/orders").ArgumentList);
    }

    /// <summary>Исполнители — логины через запятую, ничья задача — без исполнителя; своя — среди них вход gh.</summary>
    [Fact]
    public void Parse_TakesAssigneesAndMarksOwn()
    {
        var issues = GhIssues.Parse("""
            [{"number":1,"title":"А","url":"u1","assignees":[{"login":"Boris","name":"Борис"}]},
             {"number":2,"title":"Б","url":"u2","assignees":[{"login":"anna"},{"login":"boris"}]},
             {"number":3,"title":"В","url":"u3","assignees":[{"login":"anna"}]},
             {"number":4,"title":"Г","url":"u4","assignees":[]}]
            """, "boris");

        Assert.Equal(
            [("Boris", true), ("anna, boris", true), ("anna", false), (null, false)],
            issues.Issues.Select(i => (i.Assignee, i.Mine)));
        Assert.All(GhIssues.Parse("""[{"number":1,"title":"А","url":"u1","assignees":[{"login":"boris"}]}]""").Issues,
            i => Assert.False(i.Mine));
    }

    /// <summary>Сто первая задача значит «есть ещё»: показываются первые сто, и вкладка говорит это строкой.</summary>
    [Fact]
    public void Parse_MoreThanHundred_KeepsHundredAndIsTruncated()
    {
        string List(int count) =>
            "[" + string.Join(",", Enumerable.Range(1, count).Select(n => $$"""{"number":{{n}},"title":"Т","url":"u"}""")) + "]";

        var full = GhIssues.Parse(List(101));
        var exact = GhIssues.Parse(List(100));

        Assert.True(full.Truncated);
        Assert.Equal(100, full.Issues.Count);
        Assert.Equal(100, full.Issues[^1].Number);
        Assert.False(exact.Truncated);
        Assert.Equal(100, exact.Issues.Count);
    }

    [Fact]
    public void Parse_NamesIssuesAsKitDoes()
    {
        var issues = GhIssues.Parse("""[{"number":37,"title":"Оплата падает","url":"https://github.com/acme/orders/issues/37"}]""");

        Assert.Null(issues.Problem);
        Assert.Equal(new TrackerIssue("GitHub #37", 37, "Оплата падает", "https://github.com/acme/orders/issues/37"), Assert.Single(issues.Issues));
    }

    /// <summary>Метки задачи — их имена в порядке gh; цвет и описание метки панели не нужны (B-305).</summary>
    [Fact]
    public void Parse_TakesLabelNames()
    {
        var issues = GhIssues.Parse("""
            [{"number":37,"title":"Оплата падает","url":"https://github.com/acme/orders/issues/37",
              "labels":[{"id":"LA_1","name":"bug","description":"","color":"d73a4a"},{"id":"LA_2","name":"ui","description":"","color":"a2eeef"}]}]
            """);

        Assert.Equal(
            new TrackerIssue("GitHub #37", 37, "Оплата падает", "https://github.com/acme/orders/issues/37", ["bug", "ui"]),
            Assert.Single(issues.Issues));
    }

    [Fact]
    public void LabelsStartInfo_AsksAllLabelNamesOfRepositoryByName()
    {
        var startInfo = GhIssues.LabelsStartInfo("acme/orders");

        Assert.Equal("gh", startInfo.FileName);
        Assert.Equal(
            ["label", "list", "--repo", "acme/orders", "--limit", "1000", "--sort", "name", "--json", "name"],
            startInfo.ArgumentList);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal("1", startInfo.Environment["GH_PROMPT_DISABLED"]);
    }

    [Fact]
    public void ParseLabels_TakesNames_NotJsonIsNull()
    {
        Assert.Equal(["bug", "ui"], GhIssues.ParseLabels("""[{"name":"bug"},{"name":"ui"}]"""));
        Assert.Null(GhIssues.ParseLabels("oops"));
    }

    [Fact]
    public void Parse_EmptyList_HasNoIssuesAndNoProblem()
    {
        var issues = GhIssues.Parse("[]\n");

        Assert.Empty(issues.Issues);
        Assert.Null(issues.Problem);
    }

    [Fact]
    public void Parse_NotJson_IsGitHubError()
    {
        Assert.Equal(TrackerIssues.GitHubError, GhIssues.Parse("oops").Problem);
    }

    // Строки — как их пишет gh 2.101: без входа, с негодным ключом.
    [Theory]
    [InlineData(4, "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.")]
    [InlineData(1, "failed resolving `@me` to your user handle: non-200 OK status code: 401 Unauthorized body: \"{\\\"message\\\": \\\"Bad credentials\\\"}\"")]
    public void Failed_WithoutLogin_IsGhLogin(int exitCode, string error)
    {
        Assert.Equal(new TrackerIssues([], TrackerIssues.GhLogin), GhIssues.Failed(exitCode, error));
    }

    [Theory]
    [InlineData("acme/gone")]
    // «401» в имени репозитория — не отказ входа
    [InlineData("acme/orders-401")]
    public void Failed_UnknownRepository_IsRepoUnreachable(string repo)
    {
        var issues = GhIssues.Failed(1, $"GraphQL: Could not resolve to a Repository with the name '{repo}'. (repository)\n");

        Assert.Equal(TrackerIssues.RepoUnreachable, issues.Problem);
        Assert.Equal($"GraphQL: Could not resolve to a Repository with the name '{repo}'. (repository)", issues.Detail);
    }

    /// <summary>«Назначена на оператора» и «без меток» критерия B-286 держат ключи gh; описание идёт во ввод, а не аргументом.</summary>
    [Fact]
    public void CreateStartInfo_AssignsToOperatorWithoutLabelsAndReadsBodyFromInput()
    {
        var startInfo = GhIssues.CreateStartInfo("acme/orders", "Оплата \"падает\"");

        Assert.Equal("gh", startInfo.FileName);
        Assert.Equal(
            ["issue", "create", "--repo", "acme/orders", "--title", "Оплата \"падает\"", "--body-file", "-", "--assignee", "@me"],
            startInfo.ArgumentList);
        Assert.True(startInfo.RedirectStandardInput);
        Assert.True(startInfo.CreateNoWindow);
        Assert.False(startInfo.UseShellExecute);
        Assert.Equal("1", startInfo.Environment["GH_PROMPT_DISABLED"]);
    }

    /// <summary>
    /// Без входа gh выходит, не прочитав описание: длинное описание не влезает в канал ввода, и его запись падает.
    /// Панель должна прочесть отказ gh, а не упасть сама (ревью B-286).
    /// </summary>
    [Fact]
    public async Task RunAsync_ProgramExitsWithoutReadingLongInput_GivesItsExitCodeAndError()
    {
        var startInfo = new ProcessStartInfo("pwsh")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", "[Console]::Error.WriteLine('please run gh auth login'); exit 4" })
            startInfo.ArgumentList.Add(arg);

        var run = await GhIssues.RunAsync(startInfo, new string('ж', 200_000), CancellationToken.None);

        Assert.False(run.Missing);
        Assert.False(run.TimedOut);
        Assert.Equal(4, run.ExitCode);
        Assert.Contains("gh auth login", run.Error);
    }

    [Fact]
    public void ParseCreated_TakesNumberFromLastLineAddress()
    {
        var created = GhIssues.ParseCreated("\nCreating issue in acme/orders\n\nhttps://github.com/acme/orders/issues/58\n", "Оплата падает");

        Assert.Null(created.Problem);
        Assert.Equal(new TrackerIssue("GitHub #58", 58, "Оплата падает", "https://github.com/acme/orders/issues/58"), created.Issue);
    }

    [Fact]
    public void ParseCreated_WithoutAddress_IsGitHubError()
    {
        var created = GhIssues.ParseCreated("done\n", "Оплата падает");

        Assert.Null(created.Issue);
        Assert.Equal(CreatedIssue.CreatedUnknown, created.Problem);
    }

    [Fact]
    public void Failed_Otherwise_CarriesFirstLineOfGitHub()
    {
        var issues = GhIssues.Failed(1, "\nHTTP 502: Bad Gateway (https://api.github.com/graphql)\nretry later\n");

        Assert.Equal(TrackerIssues.GitHubError, issues.Problem);
        Assert.Equal("HTTP 502: Bad Gateway (https://api.github.com/graphql)", issues.Detail);
    }
}
