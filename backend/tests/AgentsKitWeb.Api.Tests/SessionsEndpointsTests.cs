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
    public async Task Sessions_StandingSessionOfCopyWaitingForOperator_WaitsForHimToo()
    {
        WriteMemory(answer: "");
        WriteBackground(_copy, 200, "7339dced", status: "idle");

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Equal(SessionState.AwaitingOperator, Assert.Single(rows!).State);
    }

    [Fact]
    public async Task Sessions_WorkingSessionOfCopyWaitingForOperator_IsStillWorking()
    {
        WriteMemory(answer: "");
        WriteBackground(_copy, 200, "7339dced", status: "busy");

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Equal(SessionState.Working, Assert.Single(rows!).State);
    }

    [Fact]
    public async Task Sessions_StandingSessionOfCopyWhoseQuestionIsAnswered_JustStands()
    {
        WriteMemory(answer: "да");
        WriteBackground(_copy, 200, "7339dced", status: "idle");

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Equal(SessionState.Idle, Assert.Single(rows!).State);
    }

    [Fact]
    public async Task Sessions_SessionOfDirectoryOutsideBases_IsNotShown()
    {
        WriteBackground(Path.Combine(_root, "playground"), 300, "9919e753");

        var rows = await Client().GetFromJsonAsync<List<SessionRow>>("/api/sessions");

        Assert.Empty(rows!);
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

    [Fact]
    public async Task New_LaunchesBackgroundSessionInCopyWithTheOperatorsPrompt()
    {
        // Цвета claude пишет и в перенаправленный вывод: без них id не встречается вовсе.
        _agent.Lines = ["backgrounded · \u001b[36m7339dced\u001b[39m", "  claude attach 7339dced"];

        var response = await Client().PostAsJsonAsync(
            "/api/sessions/new", new SessionStartRequest(_base, _copy, "  посмотри, почему падает e2e  "));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var started = await response.Content.ReadFromJsonAsync<SessionStartResponse>();
        Assert.Equal("7339dced", started!.Session);
        // Окно с сессией открывается сразу — решение оператора на приёмке B-61
        Assert.True(started.Terminal);
        Assert.Equal([(_copy, "7339dced")], _terminals.Attached);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        // Просьба уходит после «--»: текст, начатый с «-», claude принял бы за флаг.
        // Настройками сессия оставлена в самой копии: без них claude уходит работать в отдельное дерево.
        Assert.Equal(["--settings", """{"worktree":{"bgIsolation":"none"}}""", "--bg", "--", "посмотри, почему падает e2e"], startInfo.ArgumentList);
    }

    [Fact]
    public async Task New_WithoutPrompt_StartsSessionThatJustWaits()
    {
        _agent.Lines = ["backgrounded · abc123 (idle — send a prompt to start)"];

        var response = await Client().PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, _copy, "   "));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("abc123", (await response.Content.ReadFromJsonAsync<SessionStartResponse>())!.Session);
        Assert.Equal(["--settings", """{"worktree":{"bgIsolation":"none"}}""", "--bg"], _agent.StartInfo!.ArgumentList);
    }

    [Fact]
    public async Task New_StartsSessionInCopyThatAlreadyRunsTask()
    {
        WriteMemory("");
        _agent.Lines = ["backgrounded · 7339dced"];

        var response = await Client().PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, _copy, null));

        // Сессия не под задачу памяти не заводит, и занятость копии её не отменяет — решение оператора.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(_agent.StartInfo);
    }

    [Fact]
    public async Task New_SessionThatStartedWithoutItsWindow_IsStillReturned()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        _terminals.Result = false;

        var response = await Client().PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, _copy, null));

        // Сессия завелась, и запуск не считается неудачей: в неё входят из строки перечня
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var started = await response.Content.ReadFromJsonAsync<SessionStartResponse>();
        Assert.Equal("7339dced", started!.Session);
        Assert.False(started.Terminal);
    }

    [Fact]
    public async Task New_ReportsWhyClaudeDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "\u001b[31mНе удалось найти файл\u001b[39m");

        var response = await Client().PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, _copy, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<SessionActionProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("Не удалось найти файл", problem.Message);
    }

    [Fact]
    public async Task New_ReportsClaudeThatSaidNoSessionId()
    {
        _agent.Lines = ["error: not logged in"];
        _agent.Exit = new AgentExit(1, "");

        var response = await Client().PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, _copy, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<SessionActionProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("error: not logged in", problem.Message);
    }

    [Fact]
    public async Task New_RejectsBaseOutsideListUnknownCopyAndEmptyCopy()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(other, _copy, null))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, Path.Combine(_root, "gone"), null))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/sessions/new", new SessionStartRequest(_base, " ", null))).StatusCode);
        Assert.Null(_agent.StartInfo);
        Assert.Empty(_terminals.Attached);
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

    /// <summary>Память копии с одним вопросом оператору: пустой ответ — копия его ждёт.</summary>
    private void WriteMemory(string answer) =>
        File.WriteAllText(Path.Combine(_base, "work", "app.md"), $"""
            # Задача копии
            рабочая копия: {_copy}
            ветка: dev

            ## Оператору

            ### Подтвердите критерий
            За вами объём.

            ответ: {answer}

            ## Агенту

            ### Сценарий
            - [x] 1. Критерий — выход: да
            - [ ] 2. Ветка
            """);

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

        public IReadOnlyList<string> Lines { get; set; } = [];

        public ProcessStartInfo? StartInfo { get; set; }

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            foreach (var line in Lines)
                await onLine(line);
            return Exit;
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
