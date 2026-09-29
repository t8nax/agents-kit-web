using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Проверка описания трекера перед записью — решение оператора на B-293.</summary>
public sealed class TrackerCheckTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "akw-tracker-check-" + Guid.NewGuid().ToString("N"));
    private readonly FakeGitHubIssues _github = new();
    private readonly FakeYouTrack _youTrack = new();
    private readonly TrackerServersStore _servers;

    private static readonly TrackerDescription Described = new(
        "GitHub", "https://github.com", "acme/orders", "Ходим gh.", "Мои задачи.", "Метка.", "Ничего.", "В acme/orders.");

    public TrackerCheckTests()
    {
        Directory.CreateDirectory(_root);
        _servers = new TrackerServersStore(Path.Combine(_root, "trackers.json"));
    }

    public void Dispose() => TestDirs.Delete(_root);

    private ProjectTracker Tracker() => new(_github, _youTrack, _servers);

    [Fact]
    public async Task GitHub_IssuesRead_PassesAndAsksTheRepo()
    {
        var check = await Tracker().CheckAsync(Described with { Server = "https://git.acme.local" }, CancellationToken.None);

        Assert.Equal(new TrackerCheck(true), check);
        Assert.True(check.Passed);
        Assert.Equal(["git.acme.local/acme/orders"], _github.Asked);
    }

    [Fact]
    public async Task GitHub_RepoUnreachable_BlamesProject()
    {
        _github.Answer = new TrackerIssues([], TrackerIssues.RepoUnreachable, "Could not resolve to a Repository");

        var check = await Tracker().CheckAsync(Described, CancellationToken.None);

        Assert.Equal(new TrackerCheck(true, "project", TrackerIssues.RepoUnreachable, "Could not resolve to a Repository"), check);
        Assert.False(check.Passed);
    }

    /// <summary>Нет gh или она не вошла в GitHub — это не поле окна, а программа оператора.</summary>
    [Fact]
    public async Task GitHub_NotLoggedIn_BlamesNoField()
    {
        _github.Answer = new TrackerIssues([], TrackerIssues.GhLogin);

        Assert.Equal(new TrackerCheck(true, null, TrackerIssues.GhLogin), await Tracker().CheckAsync(Described, CancellationToken.None));
    }

    [Fact]
    public async Task YouTrack_KeyKnown_ReadsProjectWithIt()
    {
        _servers.Save("https://acme.youtrack.cloud", "boris.k", "perm:ключ");

        var check = await Tracker().CheckAsync(
            Described with { Tracker = "youtrack", Server = "https://acme.youtrack.cloud/", Project = "PAY" }, CancellationToken.None);

        Assert.True(check.Passed);
        Assert.Equal([("https://acme.youtrack.cloud", "perm:ключ", "PAY")], _youTrack.Read);
    }

    [Fact]
    public async Task YouTrack_NoKey_BlamesServer()
    {
        var check = await Tracker().CheckAsync(
            Described with { Tracker = "YouTrack", Server = "https://acme.youtrack.cloud", Project = "PAY" }, CancellationToken.None);

        Assert.Equal(new TrackerCheck(true, "server", TrackerIssues.NoKey), check);
        Assert.Empty(_youTrack.Read);
    }

    [Fact]
    public async Task YouTrack_ProjectMissing_BlamesProject()
    {
        _servers.Save("https://acme.youtrack.cloud", "boris.k", "perm:ключ");
        _youTrack.Answer = new TrackerIssues([], TrackerIssues.ProjectMissing);

        var check = await Tracker().CheckAsync(
            Described with { Tracker = "YouTrack", Server = "https://acme.youtrack.cloud", Project = "ZZZ" }, CancellationToken.None);

        Assert.Equal(new TrackerCheck(true, "project", TrackerIssues.ProjectMissing), check);
    }

    /// <summary>Jira и GitLab панель не читает: описание пишется без проверки, и в трекер никто не ходит.</summary>
    [Theory]
    [InlineData("Jira", "https://acme.atlassian.net", "PAY")]
    [InlineData("GitLab", "https://gitlab.com", "acme/team/orders")]
    public async Task UnreadTracker_NotChecked(string tracker, string server, string project)
    {
        var check = await Tracker().CheckAsync(
            Described with { Tracker = tracker, Server = server, Project = project }, CancellationToken.None);

        Assert.Equal(new TrackerCheck(false), check);
        Assert.True(check.Passed);
        Assert.Empty(_github.Asked);
        Assert.Empty(_youTrack.Read);
    }
}
