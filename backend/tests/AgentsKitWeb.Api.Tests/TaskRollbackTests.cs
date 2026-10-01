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
        WriteSession(Path.Combine(copy, "src"), 101, entrypoint: "cli", name: "ручная");
        WriteSession(copy, 102, entrypoint: "cli", kind: "bg", jobId: "7339dced");
        WriteSession(copy, 103, entrypoint: "cli", kind: "bg", jobId: "9919e753", name: "соседняя");
        TestBases.TaskSession(_root, copy, "7339dced");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        // Сессию задачи откат гасит сам; сессия своего окна — и в подкаталоге копии — и чужая фоновая ему мешают
        Assert.Equal(
            [new RollbackBlocker("background", "соседняя"), new RollbackBlocker("terminal", "ручная"), new RollbackBlocker("vscode", null)],
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

    [Fact]
    public async Task Session_StopsTaskSessionAndForgetsIt()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        WriteSession(copy, 102, entrypoint: "cli", kind: "bg", jobId: "7339dced");
        TestBases.TaskSession(_root, copy, "7339dced");

        var response = await Step(copy, TaskRollback.Session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(["stop", "7339dced"], Assert.Single(_agent.Started).ArgumentList);
        Assert.Null(new TaskSessions(TaskSessions.FileBeside(TestBases.File(_root, _base))).SessionIn(copy));
    }

    [Fact]
    public async Task Session_ClaudeDidNotStopIt_IsFailureWithItsWords()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        WriteSession(copy, 102, entrypoint: "cli", kind: "bg", jobId: "7339dced");
        TestBases.TaskSession(_root, copy, "7339dced");
        _agent.Exit = new AgentExit(1, "no such session");

        var response = await Step(copy, TaskRollback.Session);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("no such session", (await response.Content.ReadFromJsonAsync<RollbackProblem>())!.Message);
    }

    [Fact]
    public async Task AnyStep_SessionInVsCode_RefusesAndTouchesNothing()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        WriteSession(copy, 100, entrypoint: "claude-vscode");
        File.WriteAllText(Path.Combine(copy, "draft.txt"), "черновик");

        foreach (var step in TaskRollback.Steps)
        {
            var response = await Step(copy, step);
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            Assert.Equal("blocked", (await response.Content.ReadFromJsonAsync<RollbackProblem>())!.Problem);
        }

        Assert.True(File.Exists(Path.Combine(copy, "draft.txt")));
        Assert.True(File.Exists(Memory(copy)));
        Assert.DoesNotContain("## B-7 ", File.ReadAllText(TestLayout.Backlog(_base)));
        Assert.Empty(_agent.Started);
    }

    [Fact]
    public async Task Backlog_EntryReturnsAtTheEndAsItWasTaken_CounterUntouched()
    {
        File.WriteAllText(TestLayout.Backlog(_base), Backlog("## B-7 Кнопка мигает\n\nКнопка мигает при наведении.\n\n### Агенту\n- место: App.tsx\n\n## B-8 Другая\n\nТекст.\n"));
        TestGit.Run(TestLayout.Personal(_base), "commit", "-q", "-am", "ещё запись");
        var copy = TakeTask("B-7 Кнопка мигает");

        var response = await Step(copy, TaskRollback.Backlog);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(
            Backlog("## B-8 Другая\n\nТекст.\n\n## B-7 Кнопка мигает\n\nКнопка мигает при наведении.\n\n### Агенту\n- место: App.tsx\n"),
            File.ReadAllText(TestLayout.Backlog(_base)));
        Assert.Empty(Status(TestLayout.Personal(_base)));
    }

    [Fact]
    public async Task Backlog_Repeated_DoesNotReturnEntryTwice()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        var client = Client();

        await Step(copy, TaskRollback.Backlog, client);
        var response = await Step(copy, TaskRollback.Backlog, client);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Single(Workspaces.Backlog.Parse(File.ReadAllText(TestLayout.Backlog(_base))), e => e.Number == "B-7");
    }

    [Fact]
    public async Task Backlog_EntryNeverWasInBacklog_IsFailure()
    {
        var copy = TakeTask("B-12 Не из бэклога");

        var response = await Step(copy, TaskRollback.Backlog);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("B-12", (await response.Content.ReadFromJsonAsync<RollbackProblem>())!.Message);
    }

    [Fact]
    public async Task Backlog_TaskFromTracker_LeavesBacklogAlone()
    {
        var copy = TakeTask("GitHub #37 Падает вход");
        var before = File.ReadAllText(TestLayout.Backlog(_base));

        var response = await Step(copy, TaskRollback.Backlog);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(before, File.ReadAllText(TestLayout.Backlog(_base)));
    }

    [Fact]
    public async Task Copy_ReturnsToItsOwnBranchErasesChangesAndDeletesTaskBranch()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        File.WriteAllText(Path.Combine(copy, "draft.txt"), "черновик");
        File.WriteAllText(Path.Combine(copy, "code.txt"), "правка поверх");

        var response = await Step(copy, TaskRollback.Copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("quiet-cedar", Output(copy, "branch", "--show-current"));
        Assert.Empty(Status(copy));
        Assert.False(File.Exists(Path.Combine(copy, "draft.txt")));
        Assert.Empty(Output(_main, "branch", "--list", "b-7-blink"));
    }

    [Fact]
    public async Task Copy_MainCopy_ReturnsToMaster()
    {
        Git(_main, "checkout", "-q", "-b", "b-7-blink");
        WriteMemory(_main, "B-7 Кнопка мигает", "b-7-blink");

        var response = await Step(_main, TaskRollback.Copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("master", Output(_main, "branch", "--show-current"));
        Assert.Empty(Output(_main, "branch", "--list", "b-7-blink"));
    }

    [Fact]
    public async Task Copy_TaskWentStraightToDev_KeepsDev()
    {
        Git(_main, "checkout", "-q", "master");
        Git(_main, "checkout", "-q", "dev");
        WriteMemory(_main, "B-7 Кнопка мигает", "dev");

        var response = await Step(_main, TaskRollback.Copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("master", Output(_main, "branch", "--show-current"));
        Assert.NotEmpty(Output(_main, "branch", "--list", "dev"));
    }

    [Fact]
    public async Task Copy_PreviousBranchIsGone_IsFailureThatErasesNothing()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        File.WriteAllText(Path.Combine(copy, "draft.txt"), "черновик");
        Git(_main, "branch", "-D", "quiet-cedar");

        var response = await Step(copy, TaskRollback.Copy);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("quiet-cedar", (await response.Content.ReadFromJsonAsync<RollbackProblem>())!.Message);
        Assert.Equal("b-7-blink", Output(copy, "branch", "--show-current"));
        Assert.True(File.Exists(Path.Combine(copy, "draft.txt")));
    }

    [Fact]
    public async Task AllSteps_CopyFailedThenCauseRemoved_RepeatFinishesAndCopyIsFree()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        var start = Output(_main, "rev-parse", "dev");
        Git(_main, "branch", "-D", "quiet-cedar");
        var client = Client();

        Assert.Equal(HttpStatusCode.NoContent, (await Step(copy, TaskRollback.Session, client)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Step(copy, TaskRollback.Backlog, client)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Step(copy, TaskRollback.Copy, client)).StatusCode);

        // Оператор вернул прежнюю ветку и откатывает снова: все шаги по порядку, сделанные — без изменений
        Git(_main, "branch", "quiet-cedar", start);
        foreach (var step in TaskRollback.Steps)
            Assert.Equal(HttpStatusCode.NoContent, (await Step(copy, step, client)).StatusCode);

        Assert.Equal("quiet-cedar", Output(copy, "branch", "--show-current"));
        Assert.Single(Workspaces.Backlog.Parse(File.ReadAllText(TestLayout.Backlog(_base))), e => e.Number == "B-7");
        var rows = await client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        Assert.Equal(WorkspaceStatus.Free, rows!.Single(r => string.Equals(r.Path, copy, StringComparison.OrdinalIgnoreCase)).Status);
    }

    [Fact]
    public async Task Copy_Repeated_ChangesNothing()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        var client = Client();
        await Step(copy, TaskRollback.Copy, client);

        var response = await Step(copy, TaskRollback.Copy, client);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("quiet-cedar", Output(copy, "branch", "--show-current"));
    }

    [Fact]
    public async Task Copy_TaskBranchOnServer_StaysThere()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        var server = Path.Combine(_root, "server.git");
        Git(_root, "init", "-q", "--bare", server);
        Git(copy, "remote", "add", "origin", server);
        Git(copy, "push", "-q", "origin", "b-7-blink");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));
        var response = await Step(copy, TaskRollback.Copy);

        Assert.True(plan!.OnGitHub);
        Assert.False(plan.Unpushed);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(Output(_main, "branch", "--list", "b-7-blink"));
        Assert.NotEmpty(Output(server, "branch", "--list", "b-7-blink"));
    }

    [Fact]
    public async Task Plan_TaskBranchNeverPushed_WarnsCommitsWillBeLost()
    {
        var copy = TakeTask("B-7 Кнопка мигает");

        var plan = await Client().GetFromJsonAsync<RollbackPlan>(PlanUrl(copy));

        Assert.True(plan!.Unpushed);
        Assert.False(plan.OnGitHub);
    }

    [Fact]
    public async Task Backlog_FileWithCrlfAndBom_KeepsItsTextAndLineEnds()
    {
        var bom = new byte[] { 0xEF, 0xBB, 0xBF };
        var text = Backlog("## B-7 Кнопка мигает\n\nКнопка мигает при наведении.\n\n## B-8 Другая\n\nТекст.\n").Replace("\n", "\r\n");
        File.WriteAllBytes(TestLayout.Backlog(_base), [.. bom, .. System.Text.Encoding.UTF8.GetBytes(text)]);
        TestGit.Run(TestLayout.Personal(_base), "commit", "-q", "-am", "CRLF");
        var copy = TakeTask("B-7 Кнопка мигает");
        var cut = File.ReadAllBytes(TestLayout.Backlog(_base));

        var response = await Step(copy, TaskRollback.Backlog);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var after = File.ReadAllBytes(TestLayout.Backlog(_base));
        // Прежний текст — байт в байт, с BOM, запись дописана после него теми же переводами строк
        Assert.Equal(bom, cut[..3]);
        Assert.Equal(cut, after[..cut.Length]);
        Assert.Equal("\r\n## B-7 Кнопка мигает\r\n\r\nКнопка мигает при наведении.\r\n", System.Text.Encoding.UTF8.GetString(after[cut.Length..]));
    }

    [Fact]
    public async Task Memory_RemovesMemoryWithItsFlowAndOrphanArtifactInOneCommit()
    {
        var personal = TestLayout.Personal(_base);
        Directory.CreateDirectory(Path.Combine(personal, "artifacts"));
        File.WriteAllText(Path.Combine(personal, "artifacts", "B-7-log.txt"), "лог");
        File.WriteAllText(Path.Combine(personal, "artifacts", "B-3-shared.txt"), "общий");
        File.WriteAllText(Path.Combine(personal, "notes.md"), "см. artifacts/B-3-shared.txt\n");
        var copy = TakeTask("B-7 Кнопка мигает");
        File.AppendAllText(Memory(copy), "\n## Артефакты\n- лог: artifacts/B-7-log.txt\n- общий: artifacts/B-3-shared.txt\n");
        TestGit.Run(personal, "commit", "-q", "-am", "артефакты");
        var commits = Output(personal, "rev-list", "--count", "HEAD");

        var response = await Step(copy, TaskRollback.Memory);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.False(File.Exists(Memory(copy)));
        Assert.False(Directory.Exists(Path.Combine(TestLayout.Work(_base), "quiet-cedar")));
        Assert.False(File.Exists(Path.Combine(personal, "artifacts", "B-7-log.txt")));
        Assert.True(File.Exists(Path.Combine(personal, "artifacts", "B-3-shared.txt")));
        Assert.Empty(Status(personal));
        Assert.Equal(int.Parse(commits) + 1, int.Parse(Output(personal, "rev-list", "--count", "HEAD")));

        var rows = await Client().GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        Assert.Equal(WorkspaceStatus.Free, rows!.Single(r => string.Equals(r.Path, copy, StringComparison.OrdinalIgnoreCase)).Status);
    }

    [Fact]
    public async Task Memory_AfterIt_StepsHaveNothingToRollBack()
    {
        var copy = TakeTask("B-7 Кнопка мигает");
        var client = Client();
        await Step(copy, TaskRollback.Memory, client);

        var response = await Step(copy, TaskRollback.Session, client);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task UnknownStep_IsRejected()
    {
        var copy = TakeTask("B-7 Кнопка мигает");

        Assert.Equal(HttpStatusCode.BadRequest, (await Step(copy, "everything")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Step(copy, null)).StatusCode);
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

    private string Memory(string copy) => Path.Combine(TestLayout.Work(_base), $"{Path.GetFileName(copy)}.md");

    private async Task<HttpResponseMessage> Step(string copy, string? step, HttpClient? client = null) =>
        await (client ?? Client()).PostAsJsonAsync("/api/tasks/rollback", new RollbackStepRequest(_base, copy, step));

    private static string Output(string directory, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = TestProcess.Start(startInfo);
        var output = process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        process.WaitForExit();
        return output.Trim();
    }

    private static string Status(string directory) => Output(directory, "status", "--porcelain");

    private void WriteMemory(string copy, string task, string branch)
    {
        var personal = TestLayout.Personal(_base);
        var memory = Memory(copy);
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
        // Взятую запись кит вырезает из бэклога тем же коммитом, что заводит память.
        var (backlog, bom) = AgentsKitWeb.Api.Flow.FlowFolder.Decode(File.ReadAllBytes(TestLayout.Backlog(_base)));
        if (Workspaces.Backlog.Blocks(backlog).FirstOrDefault(b => task.StartsWith(b.Number + " ")) is { } taken)
            File.WriteAllBytes(
                TestLayout.Backlog(_base),
                AgentsKitWeb.Api.Flow.FlowFolder.Encode(backlog.Remove(taken.Start, taken.End - taken.Start), bom));
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
