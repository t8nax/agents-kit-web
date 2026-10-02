using System.Diagnostics;
using System.Text.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Trackers;

namespace AgentsKitWeb.Api.Tests;

public sealed class AgentTrackersTests : IDisposable
{
    private const string Server = "https://acme.youtrack.cloud";

    private readonly string _root = Directory.CreateTempSubdirectory("akw-agent-trackers-").FullName;
    private readonly string _copy;
    private readonly string _base;

    public AgentTrackersTests()
    {
        _copy = Path.Combine(_root, "app");
        Directory.CreateDirectory(_copy);
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _copy);
    }

    private string ClaudeDir => Path.Combine(_root, ".claude");

    private AgentTracker? Find() => new AgentTrackers(ClaudeDir).For(BaseLayout.Read(_base), _copy, _base);

    private void Config(object config) =>
        File.WriteAllText(Path.Combine(_root, ".claude.json"), JsonSerializer.Serialize(config));

    private static object Http(string url) => new { type = "http", url, headers = new { Authorization = "Bearer perm:секрет" } };

    [Fact]
    public void NoTracker_IsNull()
    {
        Assert.Null(Find());
    }

    /// <summary>Облачная Jira подключается к Claude Code удалённым сервером Atlassian — его агент и получает (B-285).</summary>
    [Fact]
    public void Jira_TakesAtlassianRemoteServer()
    {
        TestLayout.Tracker(_base, "Jira", "https://acme.atlassian.net", "PAY");
        Config(new { mcpServers = new { slack = Http("https://slack.example.com/mcp"), atlassian = Http("https://mcp.atlassian.com/v1/sse") } });

        var tracker = Find()!;

        Assert.True(tracker.Reachable);
        Assert.Equal("atlassian", tracker.McpName);
        Assert.Equal(["mcp__atlassian"], tracker.AllowedTools);
        Assert.Contains("Jira, проект PAY", tracker.Prompt);
    }

    /// <summary>Подключение к самому сайту Jira тоже годится, как у YouTrack.</summary>
    [Fact]
    public void Jira_TakesServerWithSiteHost()
    {
        TestLayout.Tracker(_base, "Jira", "https://acme.atlassian.net", "PAY");
        Config(new { mcpServers = new { jira = Http("https://acme.atlassian.net/mcp") } });

        Assert.Equal("jira", Find()!.McpName);
    }

    [Fact]
    public void Jira_NoConnection_SaysUnreachable()
    {
        TestLayout.Tracker(_base, "Jira", "https://acme.atlassian.net", "PAY");
        Config(new { mcpServers = new { youtrack = Http($"{Server}/mcp") } });

        var tracker = Find()!;

        Assert.False(tracker.Reachable);
        Assert.Contains("посоветуй подключить Jira в Claude Code", tracker.Prompt);
    }

    [Fact]
    public void GitLab_IsNull()
    {
        TestLayout.Tracker(_base, "GitLab", "https://gitlab.com", "acme/orders");

        Assert.Null(Find());
    }

    [Fact]
    public void GitHub_GoesThroughGhOnly()
    {
        TestLayout.GitHubTracker(_base, "acme/orders");

        var tracker = Find()!;

        Assert.True(tracker.Reachable);
        Assert.Equal([AgentTracker.GhRule], tracker.AllowedTools);
        Assert.Null(tracker.McpConfig);
        Assert.Contains("--repo acme/orders", tracker.Prompt);
    }

    /// <summary>Подключение — то, чей адрес на хосте сервера трекера; прочие подключения агенту не подаются.</summary>
    [Fact]
    public void YouTrack_TakesOnlyServerWithTrackerHost()
    {
        TestLayout.Tracker(_base, "YouTrack", Server, "ACME");
        Config(new { mcpServers = new { slack = Http("https://slack.example.com/mcp"), youtrack = Http($"{Server}/mcp") } });

        var tracker = Find()!;

        Assert.Equal("youtrack", tracker.McpName);
        Assert.Equal(["mcp__youtrack"], tracker.AllowedTools);
        using var config = JsonDocument.Parse(tracker.McpConfig!);
        var servers = config.RootElement.GetProperty("mcpServers");
        Assert.Equal(["youtrack"], servers.EnumerateObject().Select(s => s.Name));
        Assert.Equal("Bearer perm:секрет", servers.GetProperty("youtrack").GetProperty("headers").GetProperty("Authorization").GetString());
    }

    /// <summary>Своё у каталога агента — раньше общего: так его берёт Claude Code.</summary>
    [Fact]
    public void YouTrack_ProjectScopeBeforeUser()
    {
        TestLayout.Tracker(_base, "YouTrack", Server, "ACME");
        Config(new
        {
            mcpServers = new { general = Http($"{Server}/mcp") },
            projects = new Dictionary<string, object> { [_copy.Replace('\\', '/')] = new { mcpServers = new { own = Http($"{Server}/mcp") } } },
        });

        Assert.Equal("own", Find()!.McpName);
    }

    [Fact]
    public void YouTrack_FromMcpJsonOfCopy()
    {
        TestLayout.Tracker(_base, "YouTrack", Server, "ACME");
        File.WriteAllText(Path.Combine(_copy, ".mcp.json"),
            JsonSerializer.Serialize(new { mcpServers = new { yt = Http($"{Server}/mcp") } }));

        Assert.Equal("yt", Find()!.McpName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("не json")]
    [InlineData("{\"mcpServers\":{\"other\":{\"type\":\"http\",\"url\":\"https://other.example.com/mcp\"}}}")]
    [InlineData("{\"mcpServers\":{\"local\":{\"type\":\"stdio\",\"command\":\"npx\"}}}")]
    public void YouTrack_NoConnection_SaysUnreachable(string? config)
    {
        TestLayout.Tracker(_base, "YouTrack", Server, "ACME");
        if (config is not null)
            File.WriteAllText(Path.Combine(_root, ".claude.json"), config);

        var tracker = Find()!;

        Assert.False(tracker.Reachable);
        Assert.Empty(tracker.AllowedTools);
        Assert.Contains("в трекер тебе не пройти", tracker.Prompt);
        var startInfo = new ProcessStartInfo("claude");
        tracker.AddMcp(startInfo);
        Assert.Empty(startInfo.ArgumentList);
    }

    [Fact]
    public void AddMcp_PassesConfigAsString()
    {
        TestLayout.Tracker(_base, "YouTrack", Server, "ACME");
        Config(new { mcpServers = new { youtrack = Http($"{Server}/mcp") } });
        var tracker = Find()!;
        var startInfo = new ProcessStartInfo("claude");

        tracker.AddMcp(startInfo);

        Assert.Equal(["--mcp-config", tracker.McpConfig!], startInfo.ArgumentList);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
