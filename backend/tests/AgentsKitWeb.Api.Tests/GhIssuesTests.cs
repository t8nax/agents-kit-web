using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class GhIssuesTests
{
    [Fact]
    public void Parse_NamesIssuesAsKitDoes()
    {
        var issues = GhIssues.Parse("""[{"number":37,"title":"Оплата падает","url":"https://github.com/acme/orders/issues/37"}]""");

        Assert.Null(issues.Problem);
        Assert.Equal(new TrackerIssue("GitHub #37", 37, "Оплата падает", "https://github.com/acme/orders/issues/37"), Assert.Single(issues.Issues));
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

    [Fact]
    public void Failed_UnknownRepository_IsRepoUnreachable()
    {
        var issues = GhIssues.Failed(1, "GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)\n");

        Assert.Equal(new TrackerIssues([], TrackerIssues.RepoUnreachable), issues);
    }

    [Fact]
    public void Failed_Otherwise_CarriesFirstLineOfGitHub()
    {
        var issues = GhIssues.Failed(1, "\nHTTP 502: Bad Gateway (https://api.github.com/graphql)\nretry later\n");

        Assert.Equal(TrackerIssues.GitHubError, issues.Problem);
        Assert.Equal("HTTP 502: Bad Gateway (https://api.github.com/graphql)", issues.Detail);
    }
}
