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

public sealed class TaskRollbackTests : IDisposable
{
    private const long ProcessStarted = 134341890912115758;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-rollback-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _main;
    private readonly string _sessionsDir;
    private readonly FakeAgent _agent = new();

    public TaskRollbackTests()
    {
        _main = TestGit.Repository(Path.Combine(_root, "app"));
        Git(_main, "branch", "master");
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _main);
        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);

        var personal = TestLayout.Personal(_base);
        TestGit.Run(personal, "config", "user.name", "t");
        TestGit.Run(personal, "config", "user.email", "t@t");
        File.WriteAllText(TestLayout.Backlog(_base), Backlog("## B-7 Кнопка мигает\n\nКнопка мигает при наведении.\n"));
        TestGit.Run(personal, "add", "backlog.md");
        TestGit.Run(personal, "commit", "-q", "-m", "бэклог");
    }

    [Fact]
    public async Task Plan_TaskFromBacklog_SaysWhereItCameFromAndThatNothingBlocks()
    {
        var copy = TakeTask("B-7 Кнопка мигает");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        Assert.Equal("B-7 Кнопка мигает", plan!.Task);
        Assert.Equal(RollbackSource.Backlog, plan.Source);
        Assert.False(plan.Dirty);
        Assert.Empty(plan.Blockers);
    }

    [Fact]
    public async Task Plan_NewFileInCopy_IsUnsavedChange()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        File.WriteAllText(Path.Combine(copy, "draft.txt"), "черновик");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        Assert.True(plan!.Dirty);
    }

    [Theory]
    [InlineData("GitHub #37 Падает вход", RollbackSource.Tracker)]
    [InlineData("Починить вход", RollbackSource.None)]
    public async Task Plan_TaskNotFromBacklog_IsNamedByItsSource(string task, string source)
    {
        var copy = TakeTask(task);

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        Assert.Equal(source, plan!.Source);
    }

    [Fact]
    public async Task Plan_SessionsPanelCannotStop_AreNamed()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        WriteSession(copy, 100, entrypoint: "claude-vscode");
        WriteSession(copy, 101, entrypoint: "cli", name: "ручная");
        WriteSession(copy, 102, entrypoint: "cli", kind: "bg", jobId: "7339dced");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        Assert.Equal(
            [new RollbackBlocker("terminal", "ручная"), new RollbackBlocker("vscode", null)],
            plan!.Blockers.OrderBy(b => b.Kind, StringComparer.Ordinal));
    }

    [Fact]
    public async Task Plan_FreeCopy_HasNothingToRollBack()
    {
        var response = await Client().GetAsync(PlanUrl(_main));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("no-task", (await response.Content.ReadFromJsonAsync<RollbackProblem>())!.Problem);
    }

    [Fact]
    public async Task Plan_BaseOutsideList_IsNotFound()
    {
        var other = TestLayout.Base(Path.Combine(_root, "other"), _main);

        var response = await Client().GetAsync($"/api/tasks/rollback?base={Uri.EscapeDataString(other)}&copy={Uri.EscapeDataString(_main)}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root, () =>
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
        });
    }

    private static string Backlog(string entries) => $"# Бэклог\n\nследующий номер: B-9\n\n{entries}";

    private string PlanUrl(string copy) =>
        $"/api/tasks/rollback?base={Uri.EscapeDataString(_base)}&copy={Uri.EscapeDataString(copy)}";

    /// <summary>
    /// Копия рядом с основной, как её заводит кит, — на ветке своего имени, — и задача в ней: ветка задачи,
    /// коммит на ней, память с флоу задачи в личном репозитории и запись, вырезанная из бэклога, если она оттуда.
    /// </summary>
    private string TakeTask(string task, string name = "quiet-cedar", string branch = "b-7-blink")
    {
        var copy = Path.Combine(_root, name);
        Git(_main, "worktree", "add", "-q", copy, "-b", name);
        Git(copy, "checkout", "-q", "-b", branch);
        File.WriteAllText(Path.Combine(copy, "code.txt"), "правка задачи");
        Git(copy, "add", "code.txt");
        Git(copy, "commit", "-q", "-m", "задача");
        WriteMemory(copy, task, branch);
        return copy;
    }

    private void WriteMemory(string copy, string task, string branch)
    {
        var personal = TestLayout.Personal(_base);
        var memory = Path.Combine(TestLayout.Work(_base), $"{Path.GetFileName(copy)}.md");
        File.WriteAllText(memory, $"""
            # {task}
            рабочая копия: {copy}
            ветка: {branch}

            ## Агенту

            ### Сценарий
            - [ ] 1. Реализация
            """);
        var flow = Path.Combine(TestLayout.Work(_base), Path.GetFileName(copy), "flow");
        Directory.CreateDirectory(Path.Combine(flow, "stages"));
        File.WriteAllText(Path.Combine(flow, "scenarios.md"), "# Сценарии\n");
        File.WriteAllText(Path.Combine(flow, "stages", "implementation.md"), "# Реализация\n");
        if (task.StartsWith("B-7 "))
            File.WriteAllText(TestLayout.Backlog(_base), Backlog(""));
        TestGit.Run(personal, "add", "-A");
        TestGit.Run(personal, "commit", "-q", "-m", "задача взята");
    }

    private static void Git(string directory, params string[] args) =>
        TestGit.Run(directory, ["-c", "user.name=t", "-c", "user.email=t@t", .. args]);

    private void WriteSession(string cwd, int pid, string entrypoint, string? kind = null, string? jobId = null, string? name = null) =>
        File.WriteAllText(Path.Combine(_sessionsDir, $"{pid}.json"), JsonSerializer.Serialize(new
        {
            pid,
            cwd,
            entrypoint,
            kind,
            jobId,
            name,
            procStart = ProcessStarted.ToString(),
            status = "idle",
        }));

    private HttpClient Client() =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
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
                services.RemoveAll<AgentSessions>();
                services.AddSingleton(new AgentSessions(_sessionsDir, _ => ProcessStarted));
            });
        })).CreateClient();

    private sealed class FakeAgent : IAgentProcess
    {
        public AgentExit Exit { get; set; } = new(0, "");

        public List<ProcessStartInfo> Started { get; } = [];

        public Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            Started.Add(startInfo);
            return Task.FromResult(Exit);
        }
    }
}
