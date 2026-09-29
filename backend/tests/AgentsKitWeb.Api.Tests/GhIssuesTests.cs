using System.Diagnostics;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class GhIssuesTests
{
    /// <summary>«Назначенные на оператора» и «открытые» критерия B-277 держат ключи gh — без них видны чужие и закрытые.</summary>
    [Fact]
    public void StartInfo_AsksOpenIssuesAssignedToOperatorWithoutWindow()
    {
        var startInfo = GhIssues.StartInfo("acme/orders");

        Assert.Equal("gh", startInfo.FileName);
        Assert.Equal(
            ["issue", "list", "--repo", "acme/orders", "--assignee", "@me", "--state", "open", "--limit", "100", "--json", "number,title,url,labels"],
            startInfo.ArgumentList);
        Assert.True(startInfo.CreateNoWindow);
        Assert.False(startInfo.UseShellExecute);
        Assert.Equal("1", startInfo.Environment["GH_PROMPT_DISABLED"]);
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
