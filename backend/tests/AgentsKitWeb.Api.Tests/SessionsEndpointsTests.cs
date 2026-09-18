using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class SessionsEndpointsTests : IDisposable
{
    /// <summary>Время старта процесса, которое видит панель, когда процесс идёт.</summary>
    private const long ProcessStarted = 134341890912115758;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-sessions-api-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _sessionsDir;
    private readonly FakeAgent _agent = new();
    private readonly FakeTerminalWindows _terminals = new();

    public SessionsEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(
            Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { workspaces = new[] { _copy } }));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);
    }

    [Fact]
    public async Task Sessions_SessionOfKnownCopy_CarriesItsProjectNameAndId()
    {
        WriteBackground(_copy, 200, "7339dced", name: "agents-kit b-50 drive", status: "busy", startedAt: 1789718008746);

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        var row = Assert.Single(rows!);
        Assert.Equal("App", row.Project);
        Assert.Equal(_base, row.Base);
        Assert.Equal(_copy, row.Path);
        Assert.Equal("agents-kit b-50 drive", row.Name);
        Assert.Equal("7339dced", row.Session);
        Assert.Equal(SessionState.Working, row.State);
        Assert.True(row.Background);
        Assert.Equal(1789718008746, row.StartedAt);
    }

    [Fact]
    public async Task Sessions_SessionOfDirectoryOutsideBases_IsShownWithoutProject()
    {
        WriteBackground(Path.Combine(_root, "playground"), 300, "9919e753");

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        var row = Assert.Single(rows!);
        Assert.Null(row.Project);
        Assert.Null(row.Base);
        Assert.Equal(Path.Combine(_root, "playground"), row.Path);
    }

    [Fact]
    public async Task Sessions_SessionInVsCode_IsShownButHasNoIdToActOn()
    {
        WriteVsCode(_copy, 100);

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        var row = Assert.Single(rows!);
        Assert.False(row.Background);
        Assert.Null(row.Session);
        Assert.Equal("App", row.Project);
    }

    [Fact]
    public async Task Sessions_SeveralSessionsInOneCopy_AreAllShownOldestFirst()
    {
        WriteBackground(_copy, 201, "bbbbbbbb", startedAt: 20);
        WriteBackground(_copy, 202, "aaaaaaaa", startedAt: 10);

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Equal(["aaaaaaaa", "bbbbbbbb"], rows!.Select(row => row.Session));
    }

    [Fact]
    public async Task Sessions_SessionsOfBasesAndOutsiders_PutOutsidersLast()
    {
        WriteBackground(Path.Combine(_root, "playground"), 300, "9919e753", startedAt: 1);
        WriteBackground(_copy, 200, "7339dced", startedAt: 2);

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Equal(["7339dced", "9919e753"], rows!.Select(row => row.Session));
    }

    [Fact]
    public async Task Sessions_FileLeftFromDeadSession_IsNotShown()
    {
        WriteBackground(_copy, 200, "7339dced");

        var rows = await Client(live: false).GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Empty(rows!);
    }

    [Fact]
    public async Task Stop_BackgroundSession_AsksClaudeToStopItById()
    {
        WriteBackground(_copy, 200, "7339dced");

        var response = await Client().PostAsJsonAsync("/api/sessions/stop", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal(["stop", "7339dced"], startInfo.ArgumentList);
    }

    [Fact]
    public async Task Stop_ClaudeFailed_AnswersWithWhatItSaid()
    {
        WriteBackground(_copy, 200, "7339dced");
        _agent.Exit = new AgentExit(1, "no such session");

        var response = await Client().PostAsJsonAsync("/api/sessions/stop", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<SessionActionProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("no such session", problem.Message);
    }

    [Fact]
    public async Task Stop_SessionThatIsNoLongerLive_IsRejectedAndClaudeIsNotCalled()
    {
        WriteBackground(_copy, 200, "7339dced");

        var response = await Client(live: false).PostAsJsonAsync("/api/sessions/stop", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("no-session", (await response.Content.ReadFromJsonAsync<SessionActionProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Stop_SessionWithItsOwnWindow_IsRejected()
    {
        WriteVsCode(_copy, 100);

        var response = await Client().PostAsJsonAsync("/api/sessions/stop", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("7339dced; rm -rf /")]
    [InlineData("../../etc")]
    public async Task Stop_IdThatIsNotASessionId_IsRejectedAndClaudeIsNotCalled(string session)
    {
        WriteBackground(_copy, 200, "7339dced");

        var response = await Client().PostAsJsonAsync("/api/sessions/stop", new SessionActionRequest(session));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Terminal_BackgroundSession_OpensTerminalInItsDirectory()
    {
        WriteBackground(_copy, 200, "7339dced");

        var response = await Client().PostAsJsonAsync("/api/sessions/terminal", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(_copy, "7339dced")], _terminals.Attached);
    }

    [Fact]
    public async Task Terminal_TerminalDidNotOpen_IsAFailure()
    {
        WriteBackground(_copy, 200, "7339dced");
        _terminals.Result = false;

        var response = await Client().PostAsJsonAsync("/api/sessions/terminal", new SessionActionRequest("7339dced"));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    public void Dispose()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void WriteBackground(
        string cwd,
        int pid,
        string jobId,
        string? name = null,
        string? status = null,
        long? startedAt = null) =>
        File.WriteAllText(Path.Combine(_sessionsDir, $"{pid}.json"), JsonSerializer.Serialize(new
        {
            pid,
            cwd,
            entrypoint = "cli",
            kind = "bg",
            jobId,
            procStart = ProcessStarted.ToString(),
            name,
            status,
            startedAt,
        }));

    private void WriteVsCode(string cwd, int pid) =>
        File.WriteAllText(Path.Combine(_sessionsDir, $"{pid}.json"), JsonSerializer.Serialize(new
        {
            pid,
            cwd,
            entrypoint = "claude-vscode",
            procStart = ProcessStarted.ToString(),
            status = "idle",
        }));

    // Настоящий claude в прогоне не запускается и окно терминала не открывается: проверяется,
    // как панель их зовёт и что делает с ответом. Живость сессии задаётся временем старта процесса.
    private HttpClient Client(bool live = true) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
                services.RemoveAll<ITerminalWindows>();
                services.AddSingleton<ITerminalWindows>(_terminals);
                services.RemoveAll<AgentSessions>();
                services.AddSingleton(new AgentSessions(_sessionsDir, _ => live ? ProcessStarted : null));
            });
        }).CreateClient();

    private sealed class FakeAgent : IAgentProcess
    {
        public AgentExit Exit { get; set; } = new(0, "");

        public ProcessStartInfo? StartInfo { get; set; }

        public Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            return Task.FromResult(Exit);
        }
    }

    private sealed class FakeTerminalWindows : ITerminalWindows
    {
        public List<(string Copy, string Session)> Attached { get; } = [];

        public bool Result { get; set; } = true;

        public Task<bool> AttachAsync(string copyPath, string sessionId, CancellationToken cancellationToken)
        {
            Attached.Add((copyPath, sessionId));
            return Task.FromResult(Result);
        }
    }
}
