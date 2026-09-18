using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Tasks;
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
    private readonly FakeAgent _agent = new();

    public TaskEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "work"));
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

    private HttpClient Client() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
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
