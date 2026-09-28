using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Reports;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Отчёт по расписанию: в назначенные дни и час, без разбора, если флоу не менялся, и с догоном пропущенного запуска.
/// Круг службы тест зовёт сам на подставленных часах; своя выдержка службы в прогоне не наступает.
/// </summary>
public sealed class ScheduledReportsTests : IDisposable
{
    // Понедельник, 28 сентября 2026 года, по часам машины.
    private static readonly DateTimeOffset Monday = Local(new DateTime(2026, 9, 28));

    private const string Answer = """{"findings":[],"discussions":[]}""";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-scheduled-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _kit;
    private readonly FakeAgent _agent = new();
    private readonly FakeTime _time = new(Monday.AddHours(8));
    private WebApplicationFactory<Program>? _factory;

    public ScheduledReportsTests()
    {
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        Directory.CreateDirectory(Path.Combine(TestLayout.Flow(_base), "stages"));
        File.WriteAllText(Path.Combine(TestLayout.Flow(_base), "scenarios.md"), "# App — сценарии\n\n## Крупные\n1. [Мерж](stages/merge.md)\n");
        File.WriteAllText(Path.Combine(TestLayout.Flow(_base), "stages", "merge.md"), "# Мерж\n\nисполнитель: оркестратор\nвыход: sha\n");

        _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        var rules = FlowRules.File(_kit);
        Directory.CreateDirectory(Path.GetDirectoryName(rules)!);
        File.WriteAllText(rules, ("# Флоу\n\n" + FlowRequirementsTests.Section).ReplaceLineEndings("\n"));
    }

    private static DateTimeOffset Local(DateTime at) => new(at, TimeZoneInfo.Local.GetUtcOffset(at));

    [Fact]
    public void LastDue_IsLatestScheduledHourNotLaterThanNow()
    {
        var schedule = new ReportSchedule(true, [DayOfWeek.Monday, DayOfWeek.Wednesday], 9);
        var zone = TimeZoneInfo.Local;

        Assert.Equal(Monday.AddHours(9), ScheduledReports.LastDue(schedule, Monday.AddHours(9), zone));
        Assert.Equal(Monday.AddHours(9), ScheduledReports.LastDue(schedule, Monday.AddDays(2).AddHours(8), zone));
        Assert.Equal(Local(new DateTime(2026, 9, 23, 9, 0, 0)), ScheduledReports.LastDue(schedule, Monday.AddHours(8), zone));
        Assert.Null(ScheduledReports.LastDue(schedule with { Days = [] }, Monday.AddHours(9), zone));
    }

    [Fact]
    public async Task Tick_RunsOnceAtScheduledHour()
    {
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday], 9);

        _time.Set(Monday.AddHours(8).AddMinutes(59));
        await Tick();
        Assert.Equal(0, _agent.Runs);

        _time.Set(Monday.AddHours(9).AddMinutes(1));
        await Tick();
        await Finished(client);
        Assert.Equal(1, _agent.Runs);
        Assert.Equal(_time.GetLocalNow(), Assert.Single(await List(client)).Report!.Built);

        // Тот же час второй раз не отрабатывается.
        await Tick();
        Assert.Equal(1, _agent.Runs);
    }

    [Fact]
    public async Task Tick_UnchangedFlow_OnlyMovesCheckTime()
    {
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday, DayOfWeek.Tuesday], 9);
        _time.Set(Monday.AddHours(9));
        await Tick();
        await Finished(client);
        var built = Assert.Single(await List(client)).Report!.Built;

        _time.Set(Monday.AddDays(1).AddHours(9));
        await Tick();

        Assert.Equal(1, _agent.Runs);
        var report = Assert.Single(await List(client)).Report!;
        Assert.Equal(built, report.Built);
        Assert.Equal(Monday.AddDays(1).AddHours(9), report.Checked);
    }

    [Fact]
    public async Task Tick_ChangedFlow_RunsAgain()
    {
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday, DayOfWeek.Tuesday], 9);
        _time.Set(Monday.AddHours(9));
        await Tick();
        await Finished(client);

        File.AppendAllText(Path.Combine(TestLayout.Flow(_base), "stages", "merge.md"), "\n- Мержить после «принято».\n");
        _time.Set(Monday.AddDays(1).AddHours(9));
        await Tick();
        await Finished(client);

        Assert.Equal(2, _agent.Runs);
    }

    [Fact]
    public async Task Tick_MissedHour_IsCaughtUpOnce()
    {
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday], 9);

        // Панели не было в понедельник в девять: в среду она заработала.
        _time.Set(Monday.AddDays(2).AddHours(10));
        await Tick();
        await Finished(client);
        await Tick();

        Assert.Equal(1, _agent.Runs);
    }

    [Fact]
    public async Task Tick_HourPassedBeforeScheduleWasSaved_IsNotCaughtUp()
    {
        _time.Set(Monday.AddHours(10));
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday], 9);

        await Tick();

        Assert.Equal(0, _agent.Runs);
    }

    [Fact]
    public async Task Tick_WaitsWhileOutcomeIsUnread()
    {
        var client = await Client();
        await Schedule(client, [DayOfWeek.Monday, DayOfWeek.Tuesday], 9);
        _time.Set(Monday.AddHours(9));
        await Tick();
        await Outcome(client);

        // Итог понедельника оператор не прочёл: разбор вторника его не заменяет, а ждёт.
        File.AppendAllText(Path.Combine(TestLayout.Flow(_base), "stages", "merge.md"), "\n- Мержить после «принято».\n");
        _time.Set(Monday.AddDays(1).AddHours(9));
        await Tick();
        Assert.Equal(1, _agent.Runs);

        (await client.DeleteAsync("/api/agent/report")).EnsureSuccessStatusCode();
        await Tick();
        await Outcome(client);
        Assert.Equal(2, _agent.Runs);
    }

    [Fact]
    public async Task Tick_WaitsForFirstCheckAfterStart()
    {
        var hold = new TaskCompletionSource();
        _time.Set(Monday.AddHours(8));
        var client = await Client(new NoFindings { Hold = hold }, kitAtStart: true);
        await Schedule(client, [DayOfWeek.Monday], 9);
        _time.Set(Monday.AddHours(9));

        await Tick();
        Assert.Equal(0, _agent.Runs);

        hold.SetResult();
        await CheckedAfterStart(client);
        await Tick();
        await Outcome(client);
        Assert.Equal(1, _agent.Runs);
    }

    [Fact]
    public async Task Tick_WithoutSchedule_DoesNothing()
    {
        await Client();
        _time.Set(Monday.AddDays(7));

        await Tick();

        Assert.Equal(0, _agent.Runs);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root);
    }

    private Task Tick() => _factory!.Services.GetRequiredService<ScheduledReports>().TickAsync(CancellationToken.None);

    private static async Task Schedule(HttpClient client, IReadOnlyList<DayOfWeek> days, int hour) =>
        (await client.PutAsJsonAsync("/api/reports/flow/schedule", new FlowReportScheduleRequest(null, true, days, hour) with
        {
            Base = (await List(client)).Single().Base,
        })).EnsureSuccessStatusCode();

    private static async Task<List<FlowReportItem>> List(HttpClient client) =>
        (await client.GetFromJsonAsync<List<FlowReportItem>>("/api/reports/flow", Json))!;

    /// <summary>Разбор идёт просьбой: поток просьбы кончается вместе с ней, и оператор её читает — итог уходит.</summary>
    private static async Task Finished(HttpClient client)
    {
        await Outcome(client);
        (await client.DeleteAsync("/api/agent/report")).EnsureSuccessStatusCode();
    }

    private static async Task Outcome(HttpClient client)
    {
        using var stream = await client.GetAsync("/api/agent/report/stream?from=0");
        Assert.Equal(HttpStatusCode.OK, stream.StatusCode);
        Assert.Contains("\"reported\"", await stream.Content.ReadAsStringAsync());
    }

    private async Task<HttpClient> Client(NoFindings? checks = null, bool kitAtStart = false)
    {
        var settings = TestBases.File(_root, _base);
        if (kitAtStart)
            File.WriteAllText(settings, JsonSerializer.Serialize(new { bases = new[] { _base }, kit = _kit }));
        _factory = _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", settings),
                    new("ReportScheduleIntervalSeconds", "86400"),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
                services.RemoveAll<IKitChecks>();
                services.AddSingleton<IKitChecks>(checks ?? new NoFindings());
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(_time);
            });
        }));
        var client = _factory.CreateClient();
        if (!kitAtStart)
            (await client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
        // Круг расписания ждёт первой сверки после старта: без этого ожидания тест проверял бы, успела ли она.
        if (checks?.Hold is null)
            await CheckedAfterStart(client);
        return client;
    }

    private static async Task CheckedAfterStart(HttpClient client)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while ((await client.GetFromJsonAsync<JsonElement>("/api/health", deadline.Token)).GetProperty("pending").GetBoolean())
            await Task.Delay(50, deadline.Token);
    }

    private sealed class NoFindings : IKitChecks
    {
        /// <summary>Задана — сверка не кончается, пока тест её не отпустит.</summary>
        public TaskCompletionSource? Hold { get; init; }

        public async Task<(KitCheckResult? Result, string? Error)> RunAsync(
            string kit, string basePath, IReadOnlyList<string> copies, CancellationToken cancellationToken)
        {
            if (Hold is not null)
                await Hold.Task.WaitAsync(cancellationToken);
            return (new KitCheckResult([], []), null);
        }
    }

    private sealed class FakeAgent : IAgentProcess
    {
        private int _runs;

        public int Runs => Volatile.Read(ref _runs);

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _runs);
            await onLine(JsonSerializer.Serialize(new
            {
                type = "result", subtype = "success", is_error = false, duration_ms = 100, result = Answer,
            }));
            return new AgentExit(0, "");
        }
    }

    private sealed class FakeTime(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public void Set(DateTimeOffset at) => _now = at;

        // TimeProvider считает время отсюда UTC: местное время часов переводится, иначе GetLocalNow сдвинет его ещё раз.
        public override DateTimeOffset GetUtcNow() => _now.ToUniversalTime();
    }
}
