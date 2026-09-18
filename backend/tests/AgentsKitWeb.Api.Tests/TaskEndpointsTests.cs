using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class TaskEndpointsTests : IDisposable
{
    private const string Backlog = """
        # Order Service — бэклог

        следующий номер: B-9

        ## B-7 Панель показывает задачу сразу

        Текст оператору.

        ### Агенту
        - где: App.tsx

        ## B-8 Кнопка запуска

        Текст оператору.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-tasks-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _sessionsDir;
    private readonly FakeAgent _agent = new();

    public TaskEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), JsonSerializer.Serialize(new { workspaces = new[] { _copy } }));
        File.WriteAllText(Path.Combine(_base, "backlog.md"), Backlog.ReplaceLineEndings("\n") + "\n");
    }

    [Fact]
    public async Task Start_LaunchesBackgroundDriveSessionInCopyAndReturnsItsId()
    {
        _agent.Lines = ["Starting background service…", "backgrounded · 7339dced"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("7339dced", (await response.Content.ReadFromJsonAsync<TaskStartResponse>())!.Session);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        // Просьба уходит после «--»: текст, начатый с «-», claude принял бы за флаг.
        Assert.Equal(["--bg", "--", "/agents-kit:drive B-7"], startInfo.ArgumentList);
        // Панель не правит бэклог и не заводит память: и то и другое делает навык кита в этой сессии.
        Assert.Contains("B-7", File.ReadAllText(Path.Combine(_base, "backlog.md")));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_base, "work")));
    }

    /// <summary>Переход в сессию копии ведёт по этой отметке: иначе «ту самую» сессию не узнать.</summary>
    [Fact]
    public async Task Start_RemembersTheSessionItStartedInTheCopy()
    {
        _agent.Lines = ["backgrounded \u00b7 7339dced"];

        await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        var remembered = new TaskSessions(TaskSessions.FileBeside(Path.Combine(_root, "panel", "bases.json")));
        Assert.Equal("7339dced", remembered.SessionIn(_copy));
    }

    [Fact]
    public async Task Start_TakesCyrillicNumberAsTheSameRecord()
    {
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "В-8"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("/agents-kit:drive B-8", _agent.StartInfo!.ArgumentList[2]);
    }

    [Fact]
    public async Task Start_RejectsCopyThatAlreadyHasTaskMemory()
    {
        File.WriteAllText(Path.Combine(_base, "work", "app.md"), $"""
            # B-5 Прошлая задача
            рабочая копия: {_copy}
            ветка: dev
            """);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("copy-busy", problem!.Problem);
        Assert.Equal("B-5 Прошлая задача", problem.Message);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_RejectsSecondStartUntilMemoryAppears()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"))).StatusCode);
        _agent.StartInfo = null;

        var second = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-8"));

        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        var problem = await second.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("copy-starting", problem!.Problem);
        Assert.Equal("7339dced", problem.Message);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_RejectsNumberThatIsNotInBacklog()
    {
        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-99"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("record-unknown", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_ReportsWhyClaudeDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удалось найти указанный файл");

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("Не удалось найти указанный файл", problem.Message);
    }

    [Fact]
    public async Task Start_ReportsClaudeThatSaidNoSessionId()
    {
        _agent.Lines = ["error: not logged in"];
        _agent.Exit = new AgentExit(1, "");

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("error: not logged in", problem.Message);
    }

    [Fact]
    public async Task Start_RejectsBaseOutsideListUnknownCopyAndBrokenNumber()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(other, _copy, "B-7"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, Path.Combine(_root, "gone"), "B-7"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "drive; rm -rf"))).StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>
    /// Пока агент не завёл память, о задаче знает только панель: строка копии стоит её номером с заголовком
    /// записи и статусом «запускается», а кнопку «Взять задачу» фронт у такой копии не рисует.
    /// </summary>
    [Fact]
    public async Task StartedTask_ShowsInTheCopyRowBeforeTheAgentWritesItsMemory()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: true);

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Starting, row.Status);
        Assert.Equal("B-7 Панель показывает задачу сразу", row.Task);
        Assert.Null(row.FlowStep);
        Assert.Null(row.Progress);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_base, "work")));
    }

    /// <summary>Появилась память — строка живёт по ней, и отметка панели о запуске больше ничего не значит.</summary>
    [Fact]
    public async Task StartedTask_GivesWayToTheMemoryTheAgentWrote()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: true);
        WriteMemory("B-7 Задача, как её назвал агент");

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.InWork, row.Status);
        Assert.Equal("B-7 Задача, как её назвал агент", row.Task);
    }

    /// <summary>
    /// Сессия ушла, не заведя памяти — запуск сорвался или её погасили: копия снова свободна, и задачу
    /// в неё запускают заново.
    /// </summary>
    [Fact]
    public async Task StartedTask_WhoseSessionIsGone_LeavesTheCopyFreeAgain()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: false);

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Free, row.Status);
        Assert.Null(row.Task);

        _agent.StartInfo = null;
        var again = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-8"));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
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

    private async Task<WorkspaceRow> Row(HttpClient client)
    {
        var rows = await client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        return Assert.Single(rows!, row => row.Path == _copy);
    }

    /// <summary>Память задачи, какой её завёл агент: копия занята, и строка идёт уже из неё.</summary>
    private void WriteMemory(string task) =>
        File.WriteAllText(Path.Combine(_base, "work", "app.md"), string.Join('\n', [
            "# " + task,
            "рабочая копия: " + _copy,
            "ветка: feat/row",
        ]));

    /// <summary>
    /// Запись реестра о фоновой сессии копии. Живой её делает номер процесса прогона: панель сверяет
    /// время старта, и запись с чужим временем считается брошенной.
    /// </summary>
    private void WriteSession(string jobId, bool live)
    {
        var procStart = Process.GetCurrentProcess().StartTime.ToFileTimeUtc() + (live ? 0 : 1);
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{Environment.ProcessId}.json"),
            JsonSerializer.Serialize(new
            {
                pid = Environment.ProcessId,
                cwd = _copy,
                entrypoint = "cli",
                kind = "bg",
                jobId,
                status = "busy",
                procStart = procStart.ToString(),
            }));
    }

    private HttpClient Client() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, _base)),
                    new("SessionsDir", _sessionsDir),
                ]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и что делает с ответом.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
            });
        }).CreateClient();

    private sealed class FakeAgent : IAgentProcess
    {
        public IReadOnlyList<string> Lines { get; set; } = [];
        public AgentExit Exit { get; set; } = new(0, "");
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
}
