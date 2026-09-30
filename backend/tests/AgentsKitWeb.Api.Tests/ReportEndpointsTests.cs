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
/// Отчёт о флоу: панель зовёт Чудо-Юдо в каталоге базы только на чтение, подаёт ему рекомендации кита, флоу и субагентов,
/// разбирает его ответ, считает кольца и хранит отчёт у себя, не в базе. Настоящий claude в прогоне не запускается.
/// </summary>
public sealed class ReportEndpointsTests : IDisposable
{
    private const string Scenarios = "# App — сценарии\n\n## Крупные задачи\nкогда: много работы\n1. [Мерж](stages/merge.md)\n";

    private const string Merge = "# Мерж\n\nисполнитель: оркестратор\nвыход: sha в dev\n";

    private const string Answer = """
        {"findings":[{"requirements":["П1","С1"],"place":"Мерж","quotes":[{"where":"Мерж, описание","text":"Спросить «принято»."}],
          "why":"На отказ оператора задаче некуда идти.","fix":"Добавить возврат на этап «Реализация»."},
          {"requirements":["П5"],"place":"Ревью","quotes":[],"why":"Вердикт живёт только в разговоре.","fix":"Записать вердикт выходом."}],
         "discussions":[{"title":"Делить ли мерж","place":"Мерж","now":"Один этап.","for":"Проще проверить.","against":"Больше отметок."}]}
        """;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-report-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _kit;
    private readonly FakeAgent _agent = new();

    public ReportEndpointsTests()
    {
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        Directory.CreateDirectory(Path.Combine(TestLayout.Flow(_base), "stages"));
        File.WriteAllText(Path.Combine(TestLayout.Flow(_base), "scenarios.md"), Scenarios);
        File.WriteAllText(Path.Combine(TestLayout.Flow(_base), "stages", "merge.md"), Merge);
        Directory.CreateDirectory(TestLayout.Agents(_base));
        File.WriteAllText(Path.Combine(TestLayout.Agents(_base), "reviewer.md"), "---\nname: reviewer\n---\n\nЧитает дифф.\n");

        _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        WriteRules("# Флоу\n\n## Этап\n\nКлючи.\n\n" + FlowRequirementsTests.Section.Replace(
            "### Ясность", "### Согласованность\n- **С1** · высокий · **Флоу себе не противоречит** — этап не противоречит себе.\n\n### Ясность"));
    }

    [Fact]
    public async Task Run_StreamsStepsAndStoresReportWithRings()
    {
        _agent.Lines = [Tool("Read", new { file_path = Path.Combine(_base, "product.md") }), Result(Answer)];
        var client = await Client();

        var events = await Run(client);

        Assert.Equal("step", events[0].Type);
        Assert.Equal(new FlowReportEvent("reported", "Отчёт построен."), events[^1]);

        var item = Assert.Single(await List(client));
        Assert.Null(item.Blocked);
        var report = item.Report!;
        Assert.Equal(2, report.Findings.Count);
        Assert.Equal(["П1", "С1"], report.Findings[0].Requirements);
        Assert.Equal("Делить ли мерж", Assert.Single(report.Discussions).Title);
        // Находка под двумя рекомендациями снимает в обоих кольцах: −15 −7 в проходимости, −15 в согласованности.
        Assert.Equal(new RingScore("Проходимость", 78, "avg", 2, 0), report.Rings[0]);
        Assert.Equal(new RingScore("Согласованность", 85, "avg", 1, 0), report.Rings[1]);
        Assert.Equal(new RingScore("Ясность", 100, "pass", 1, 1), report.Rings[2]);
        // Формулировка рекомендации — дословно из справки кита.
        Assert.Equal("у каждого исхода есть продолжение.", report.Requirements.First(r => r.Code == "П1").Text);
        // Отчёт у панели, рядом с bases.json, а не в базе.
        Assert.True(File.Exists(ReportsStore.FileBeside(TestBases.File(_root, _base))));
        Assert.Empty(Directory.EnumerateFiles(_base, "reports.json", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Run_StartsReadOnlyClaudeInBaseAndGivesItRequirementsFlowAndAgents()
    {
        _agent.Lines = [Result(Answer)];
        var client = await Client();

        await Run(client);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_base, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("auto", args[args.IndexOf("--permission-mode") + 1]);
        Assert.Contains("--no-session-persistence", args);
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains("официальным стилем", prompt);
        Assert.Contains(TestLayout.Personal(_base), prompt);
        // Кит зовёт правила рекомендациями, и разбор говорит о них так же: выполнять ли каждую, решает оператор — B-298.
        Assert.Contains("выполнять ли каждую, решает", prompt);
        Assert.DoesNotContain("требован", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Рекомендации к флоу из справки кита:\n\n## Рекомендации к флоу", _agent.Input);
        Assert.Contains("=== flow/scenarios.md\n# App — сценарии", _agent.Input);
        Assert.Contains("=== flow/stages/merge.md\n# Мерж", _agent.Input);
        Assert.Contains("=== agents/reviewer.md\n---\nname: reviewer", _agent.Input);
    }

    [Fact]
    public async Task Run_RejectedAnswer_KeepsNoReportAndShowsWhy()
    {
        _agent.Lines = [Result("Флоу в порядке.")];
        var client = await Client();

        var events = await Run(client);

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Contains("Панель не приняла ответ Чудо-Юдо", error.Text);
        Assert.Equal("Флоу в порядке.", error.Output);
        Assert.Null(Assert.Single(await List(client)).Report);
    }

    [Fact]
    public async Task Run_AgentThatDidNotStart_IsNamed()
    {
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = await Client();

        var error = Assert.Single(await Run(client));

        Assert.Equal("Claude Code не запустился.", error.Text);
        Assert.Equal("Не удаётся найти указанный файл", error.Output);
    }

    [Fact]
    public async Task Cancel_KeepsPreviousReport()
    {
        _agent.Lines = [Result(Answer)];
        var client = await Client();
        await Run(client);
        var before = Assert.Single(await List(client)).Report!.Built;

        _agent.Hold = true;
        using var started = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        await _agent.Started.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/agent/report")).StatusCode);
        await _agent.Stopped.Task.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(before, Assert.Single(await List(client)).Report!.Built);
    }

    [Fact]
    public async Task KitWithoutRecommendations_BlocksReportWithReason()
    {
        WriteRules("# Флоу\n\n## Этап\n\nКлючи.\n");
        var client = await Client();

        using var run = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));

        Assert.Equal(HttpStatusCode.Conflict, run.StatusCode);
        var block = (await run.Content.ReadFromJsonAsync<ReportBlock>(Json))!;
        Assert.Equal("kit", block.Kind);
        Assert.Contains("нет раздела «Рекомендации к флоу»", block.Reason);
        Assert.Equal("kit", Assert.Single(await List(client)).Blocked!.Kind);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task AnyBlock_HidesPreviousReport()
    {
        _agent.Lines = [Result(Answer)];
        var client = await Client();
        await Run(client);

        // Кит сменился на тот, где рекомендаций нет: прошлый отчёт под сообщением не показывается, как на макете.
        WriteRules("# Флоу\n\n## Этап\n\nКлючи.\n");
        var item = Assert.Single(await List(client));

        Assert.Equal("kit", item.Blocked!.Kind);
        Assert.Null(item.Report);
    }

    [Fact]
    public async Task FirstCheckAfterStart_HoldsReportUntilItEnds()
    {
        var hold = new TaskCompletionSource();
        var checks = new FakeChecks { Hold = hold };
        // Отчёт, построенный до перезапуска панели, лежит у неё.
        var built = new DateTimeOffset(2026, 9, 26, 12, 30, 0, TimeSpan.Zero);
        new ReportsStore(ReportsStore.FileBeside(TestBases.File(_root, _base))).SaveReport(_base, ReportsStore.FlowKind,
            new FlowReport(built, built, "отпечаток", [], [], []));
        var client = await Client(checks);

        var listed = Assert.Single(await List(client));
        var waiting = listed.Blocked!;
        Assert.Equal("check", waiting.Kind);
        Assert.Contains("Идёт сверка баз", waiting.Reason);
        // Сверка держит только запуск: сохранённый отчёт виден (ревью B-270).
        Assert.Equal(built, listed.Report!.Built);
        using var run = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));
        Assert.Equal(HttpStatusCode.Conflict, run.StatusCode);
        Assert.Null(_agent.StartInfo);

        hold.SetResult();
        await Checked(client, item => item.Blocked is null);
    }

    [Fact]
    public async Task FlowErrorsOfCheck_BlockReportAndHideIt_ErrorsElsewhereDoNot()
    {
        _agent.Lines = [Result(Answer)];
        var checks = new FakeChecks();
        var client = await Client(checks);
        await Run(client);

        // Ошибка сверки вне флоу разбору не мешает, и отчёт виден.
        checks.Findings = [new KitFinding("FAIL", "local/me/agents/reviewer.md", "нет name")];
        var outside = await Checked(client, item => item.Blocked is null && checks.Calls > 1);
        Assert.NotNull(outside.Report);

        // Ошибка во флоу — отчёт не строится, прошлый не показывается, раздел ведёт в «Проблемы баз».
        checks.Findings = [new KitFinding("FAIL", "local/me/flow/scenarios.md", "пункт сценария — не ссылка")];
        var blocked = await Checked(client, item => item.Blocked?.Kind == "health");
        Assert.Null(blocked.Report);
        Assert.Equal("Во флоу проекта App обнаружены ошибки сверки: 1. Отчёт будет построен после их исправления.", blocked.Blocked!.Reason);
        using var run = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));
        Assert.Equal(HttpStatusCode.Conflict, run.StatusCode);
        Assert.Equal("health", (await run.Content.ReadFromJsonAsync<ReportBlock>(Json))!.Kind);
    }

    [Fact]
    public async Task ProjectWithoutScenarios_IsNotRun()
    {
        File.Delete(Path.Combine(TestLayout.Flow(_base), "scenarios.md"));
        var client = await Client();

        using var run = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));

        Assert.Equal(HttpStatusCode.Conflict, run.StatusCode);
        Assert.Equal("flow", (await run.Content.ReadFromJsonAsync<ReportBlock>(Json))!.Kind);
        Assert.Null(_agent.StartInfo);
        // Раздел видит этот отказ сразу, а не только после нажатия.
        Assert.Equal("flow", Assert.Single(await List(client)).Blocked!.Kind);
    }

    [Fact]
    public async Task Schedule_IsSavedPerProjectAndValidated()
    {
        var client = await Client();
        Assert.False(Assert.Single(await List(client)).Schedule.Enabled);
        // Служебная проверка расписания в ответ не уходит.
        Assert.DoesNotContain("isValid", await client.GetStringAsync("/api/reports/flow"));

        using var saved = await client.PutAsJsonAsync("/api/reports/flow/schedule",
            new FlowReportScheduleRequest(_base, true, [DayOfWeek.Friday, DayOfWeek.Monday], 9));
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var schedule = Assert.Single(await List(client)).Schedule;
        Assert.True(schedule.Enabled);
        Assert.Equal([DayOfWeek.Monday, DayOfWeek.Friday], schedule.Days);

        using var wrong = await client.PutAsJsonAsync("/api/reports/flow/schedule", new FlowReportScheduleRequest(_base, true, [], 24));
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
    }

    [Fact]
    public async Task BaseOutsideList_IsNotFound()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = await Client();

        Assert.Equal(HttpStatusCode.NotFound,
            (await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(other))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await client.PutAsJsonAsync("/api/reports/flow/schedule", new FlowReportScheduleRequest(other, false, [], 9))).StatusCode);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root);
    }

    private void WriteRules(string text)
    {
        var rules = FlowRules.File(_kit);
        Directory.CreateDirectory(Path.GetDirectoryName(rules)!);
        File.WriteAllText(rules, text.ReplaceLineEndings("\n"));
    }

    private static string Tool(string name, object input) => JsonSerializer.Serialize(new
    {
        type = "assistant",
        message = new { content = new object[] { new { type = "tool_use", name, input } } },
    });

    private static string Result(string text) => JsonSerializer.Serialize(new
    {
        type = "result",
        subtype = "success",
        is_error = false,
        duration_ms = 9200,
        result = text,
    });

    private static async Task<List<FlowReportItem>> List(HttpClient client) =>
        (await client.GetFromJsonAsync<List<FlowReportItem>>("/api/reports/flow", Json))!;

    /// <summary>Как раздел: разбор заводится POST, а ход и итог читаются потоком просьбы с начала.</summary>
    private async Task<List<FlowReportEvent>> Run(HttpClient client)
    {
        using var started = await client.PostAsJsonAsync("/api/reports/flow/run", new FlowReportRunRequest(_base));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var body = await client.GetStringAsync("/api/agent/report/stream?from=0");
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<FlowReportEvent>(line, Json)!)
            .ToList();
    }

    /// <summary>Просит новую сверку и ждёт, пока раздел не покажет то, чего ждёт тест.</summary>
    private static async Task<FlowReportItem> Checked(HttpClient client, Func<FlowReportItem, bool> expected)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (true)
        {
            (await client.PostAsync("/api/health/check", null, deadline.Token)).EnsureSuccessStatusCode();
            var item = Assert.Single(await List(client));
            if (expected(item))
                return item;
            await Task.Delay(100, deadline.Token);
        }
    }

    /// <summary>
    /// Панель со сверкой-подделкой: разбор ждёт первой сверки после старта, и клиент отдаётся, когда она прошла, — кроме
    /// сверки, которую тест держит сам.
    /// </summary>
    private async Task<HttpClient> Client(FakeChecks? checks = null)
    {
        checks ??= new FakeChecks();
        // Путь к киту лежит в настройках с самого старта, как у поставленной панели: первая сверка идёт уже с китом.
        var settings = TestBases.File(_root, _base);
        File.WriteAllText(settings, JsonSerializer.Serialize(new { bases = new[] { _base }, kit = _kit }));
        var client = _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", settings)]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
                services.RemoveAll<IKitChecks>();
                services.AddSingleton<IKitChecks>(checks);
            });
        })).CreateClient();

        if (checks.Hold is null)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while ((await client.GetFromJsonAsync<JsonElement>("/api/health", deadline.Token)).GetProperty("pending").GetBoolean())
                await Task.Delay(50, deadline.Token);
        }
        return client;
    }

    private sealed class FakeChecks : IKitChecks
    {
        private int _calls;

        public IReadOnlyList<KitFinding> Findings { get; set; } = [];

        public int Calls => Volatile.Read(ref _calls);

        /// <summary>Задана — сверка не кончается, пока тест её не отпустит.</summary>
        public TaskCompletionSource? Hold { get; init; }

        public async Task<(KitCheckResult? Result, string? Error)> RunAsync(
            string kit, string basePath, IReadOnlyList<string> copies, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            if (Hold is not null)
                await Hold.Task.WaitAsync(cancellationToken);
            return (new KitCheckResult(Findings, []), null);
        }
    }

    private sealed class FakeAgent : IAgentProcess
    {
        public IReadOnlyList<string> Lines { get; set; } = [];
        public AgentExit Exit { get; set; } = new(0, "");
        public bool Hold { get; set; }
        public ProcessStartInfo? StartInfo { get; private set; }
        public string Input { get; private set; } = "";
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Stopped { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            Input = input;
            if (Hold)
            {
                // Разбор идёт, пока его не отменят: отмена убивает процесс, как настоящий AgentProcess.
                Started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                finally
                {
                    Stopped.TrySetResult();
                }
            }
            foreach (var line in Lines)
                await onLine(line);
            return Exit;
        }
    }
}
