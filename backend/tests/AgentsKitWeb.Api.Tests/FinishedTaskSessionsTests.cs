using System.Diagnostics;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Уборка отработавших сессий задач: настоящий claude в прогоне не запускается — проверяется, кого
/// панель просит погасить и кого не трогает. Живость сессии задаётся временем старта процесса.
/// </summary>
public sealed class FinishedTaskSessionsTests : IDisposable
{
    private const long ProcessStarted = 134341890912115758;
    private const string Session = "7339dced";

    private readonly string _root = Directory.CreateTempSubdirectory("akw-finished-sessions-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _sessionsDir;
    private readonly FakeAgent _agent = new();
    private readonly FakeTime _time = new(new DateTimeOffset(2026, 9, 18, 12, 0, 0, TimeSpan.Zero));
    private readonly StartedTasks _started = new();
    private readonly TaskSessions _tasks;

    public FinishedTaskSessionsTests()
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
        _tasks = new TaskSessions(Path.Combine(_root, "task-sessions.json"));
    }

    [Fact]
    public async Task FinishedSession_IsStoppedOnceItHasStoodTheDelay()
    {
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);
        var janitor = Janitor();

        // Первый круг только замечает, что сессия отработала: выдержка даёт оператору время войти в неё.
        await janitor.SweepAsync(CancellationToken.None);
        Assert.Null(_agent.StartInfo);

        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal(["stop", Session], startInfo.ArgumentList);
    }

    [Fact]
    public async Task FinishedSession_StoppedByPanel_FreesTheCopyForTheNextTask()
    {
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);
        _started.Add(_copy, Session, "B-7 Задача копии");
        var janitor = Janitor();

        await janitor.SweepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);

        // Отметка о запуске держала копию занятой, пока шла эта сессия.
        Assert.Null(_started.SessionIn(_copy));
    }

    [Fact]
    public async Task WorkingSession_IsNotStopped()
    {
        WriteBackground(_copy, 200, Session, status: "busy");
        _tasks.Remember(_copy, Session);

        await SweepTwice();

        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task SessionOfCopyThatStillRunsItsTask_IsNotStopped()
    {
        WriteMemory(answer: "да");
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);

        await SweepTwice();

        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task SessionOfCopyWaitingForOperator_IsNotStopped()
    {
        WriteMemory(answer: "");
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);

        await SweepTwice();

        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task SessionTheOperatorStartedHimself_IsNotStopped()
    {
        // Панель знает сессию задачи только по своему запуску: этой в её списке нет.
        WriteBackground(_copy, 200, Session, status: "idle");

        await SweepTwice();

        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task SessionThatWentBackToWork_StartsItsDelayAnew()
    {
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);
        var janitor = Janitor();

        await janitor.SweepAsync(CancellationToken.None);
        WriteBackground(_copy, 200, Session, status: "busy");
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);
        Assert.Null(_agent.StartInfo);

        // Снова встала — выдержка идёт с этого круга, а не с прошлого простоя.
        WriteBackground(_copy, 200, Session, status: "idle");
        await janitor.SweepAsync(CancellationToken.None);
        Assert.Null(_agent.StartInfo);

        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);
        Assert.NotNull(_agent.StartInfo);
    }

    [Fact]
    public async Task SessionThatDidNotStop_StaysAndIsTriedAgainAfterTheDelay()
    {
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);
        _started.Add(_copy, Session, "B-7 Задача копии");
        _agent.Exit = new AgentExit(1, "no such session");
        var janitor = Janitor();

        await janitor.SweepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);

        Assert.Equal(1, _agent.Runs);
        // Гашение не вышло — копия так и числится занятой запуском, а сессия остаётся в перечне.
        Assert.Equal(Session, _started.SessionIn(_copy));

        // Следующая попытка — отстояв выдержку заново, а не каждым кругом.
        await janitor.SweepAsync(CancellationToken.None);
        Assert.Equal(1, _agent.Runs);
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);
        Assert.Equal(2, _agent.Runs);
    }

    [Fact]
    public async Task DeadSessionLeftInTheRegistry_IsNotStopped()
    {
        WriteBackground(_copy, 200, Session, status: "idle");
        _tasks.Remember(_copy, Session);
        var janitor = Janitor(live: false);

        await janitor.SweepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);

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

    private async Task SweepTwice()
    {
        var janitor = Janitor();
        await janitor.SweepAsync(CancellationToken.None);
        _time.Advance(TimeSpan.FromMinutes(6));
        await janitor.SweepAsync(CancellationToken.None);
    }

    private FinishedTaskSessions Janitor(bool live = true) => new(
        new BasesStore(TestBases.File(_root, _base)),
        new AgentSessions(_sessionsDir, _ => live ? ProcessStarted : null),
        _tasks,
        _started,
        _agent,
        _time,
        new ConfigurationBuilder().Build(),
        NullLogger<FinishedTaskSessions>.Instance);

    private void WriteBackground(string cwd, int pid, string jobId, string? status = null) =>
        File.WriteAllText(Path.Combine(_sessionsDir, $"{pid}.json"), JsonSerializer.Serialize(new
        {
            pid,
            cwd,
            entrypoint = "cli",
            kind = "bg",
            jobId,
            procStart = ProcessStarted.ToString(),
            status,
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

            ### Флоу
            - [x] 1. Критерий — выход: да
            - [ ] 2. Ветка
            """);

    private sealed class FakeAgent : IAgentProcess
    {
        public AgentExit Exit { get; set; } = new(0, "");

        public ProcessStartInfo? StartInfo { get; private set; }

        public int Runs { get; private set; }

        public Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            Runs++;
            return Task.FromResult(Exit);
        }
    }

    private sealed class FakeTime(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public void Advance(TimeSpan span) => _now += span;

        public override DateTimeOffset GetUtcNow() => _now;
    }
}
