using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class AskEndpointsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-ask-").FullName;
    private readonly string _base;
    private readonly FakeAgent _agent = new();

    public AskEndpointsTests()
    {
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(_base);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
    }

    [Fact]
    public async Task Bases_ReturnsBasesWithProjectNames()
    {
        var bases = await Client(_base).GetFromJsonAsync<List<AskBase>>("/api/ask/bases");

        Assert.Equal([new AskBase(_base, "Order Service")], bases);
    }

    [Fact]
    public async Task Ask_StreamsStepsAndAnswerWithFilesRead()
    {
        var file = Path.Combine(_base, "decisions", "ui.md");
        _agent.Lines =
        [
            """{"type":"system","subtype":"init","tools":["Read"]}""",
            Tool("Grep", new { pattern = "опрос", path = Path.Combine(_base, "decisions") }),
            Tool("Read", new { file_path = file }),
            """{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}""",
            """{"type":"result","subtype":"success","is_error":false,"duration_ms":8335,"result":"Так решил оператор."}""",
        ];

        var events = await Ask(Client(_base), _base, "Почему опрос?");

        Assert.Equal(
            [
                new AskEvent("step", "ищет «опрос» в decisions"),
                new AskEvent("step", "читает decisions/ui.md"),
            ],
            events.Take(2));
        var answer = events[2];
        Assert.Equal("answer", answer.Type);
        Assert.Equal("Так решил оператор.", answer.Text);
        Assert.Equal(["decisions/ui.md"], answer.Files);
        Assert.Equal(8335, answer.DurationMs);
        Assert.Equal(3, events.Count);
    }

    [Fact]
    public async Task Ask_RunsReadOnlyClaudeInBaseWithQuestionOnStdin()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":false,"result":"ok"}"""];

        await Ask(Client(_base), _base, "--help и ещё вопрос");

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_base, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.False(startInfo.UseShellExecute);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Contains("-p", args);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        Assert.DoesNotContain(args, a => a.Contains("dangerously", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("--help и ещё вопрос", _agent.Input);
    }

    [Fact]
    public async Task Ask_StreamsEachLineAsAgentWritesIt()
    {
        var release = new TaskCompletionSource();
        _agent.Lines =
        [
            Tool("Read", new { file_path = Path.Combine(_base, "product.md") }),
            """{"type":"result","subtype":"success","is_error":false,"result":"ok"}""",
        ];
        _agent.BeforeLine = index => index == 1 ? release.Task : Task.CompletedTask;

        var client = Client(_base);
        (await client.SendAsync(Post(_base, "Что за проект?"))).EnsureSuccessStatusCode();
        using var response = await client.GetAsync(
            "/api/agent/ask/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());

        var first = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(new AskEvent("step", "читает product.md"), JsonSerializer.Deserialize<AskEvent>(first!, Json));

        release.SetResult();
        var second = JsonSerializer.Deserialize<AskEvent>((await reader.ReadLineAsync())!, Json)!;
        Assert.Equal("answer", second.Type);
    }

    [Fact]
    public async Task Ask_ReportsAgentErrorResultWithItsText()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"""];
        _agent.Exit = new AgentExit(1, "");

        var events = await Ask(Client(_base), _base, "Вопрос");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("Invalid API key · Please run /login", error.Output);
    }

    [Fact]
    public async Task Ask_ReportsExitWithoutResultWithStderrAndStdout()
    {
        _agent.Lines = ["не JSON"];
        _agent.Exit = new AgentExit(2, "что-то сломалось");

        var events = await Ask(Client(_base), _base, "Вопрос");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("что-то сломалось\nне JSON", error.Output);
    }

    [Fact]
    public async Task Ask_ReportsAgentThatDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");

        var events = await Ask(Client(_base), _base, "Вопрос");

        var error = Assert.Single(events);
        Assert.Equal("Claude Code не запустился", error.Text);
        Assert.Equal("Не удаётся найти указанный файл", error.Output);
    }

    [Fact]
    public async Task Ask_RejectsBaseOutsideListAndEmptyQuestion()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client(_base);

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Вопрос"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task AgentProcess_PassesStdinAndReturnsExitCodeAndStderr()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("$q = [Console]::In.ReadToEnd(); Write-Output \"got:$q\"; [Console]::Error.Write('oops'); exit 3");
        var lines = new List<string>();

        var exit = await new AgentProcess().RunAsync(startInfo, "вопрос", line =>
        {
            lines.Add(line);
            return Task.CompletedTask;
        }, CancellationToken.None);

        Assert.Equal(["got:вопрос"], lines);
        Assert.Equal(new AgentExit(3, "oops"), exit);
    }

    [Fact]
    public async Task AgentProcess_CancellationKillsProcess()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("Write-Output $PID; Start-Sleep -Seconds 60");
        using var cancel = new CancellationTokenSource();
        var pid = 0;

        var run = new AgentProcess().RunAsync(startInfo, "", line =>
        {
            pid = int.Parse(line);
            cancel.Cancel();
            return Task.CompletedTask;
        }, cancel.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public async Task AgentProcess_ReportsMissingProgram()
    {
        var exit = await new AgentProcess().RunAsync(
            AgentProcess.StartInfo("akw-no-such-program", _root), "", _ => Task.CompletedTask, CancellationToken.None);

        Assert.Null(exit.ExitCode);
        Assert.NotEmpty(exit.Error);
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

    private static string Tool(string name, object input) => JsonSerializer.Serialize(new
    {
        type = "assistant",
        message = new { content = new object[] { new { type = "tool_use", name, input } } },
    });

    private static HttpRequestMessage Post(string basePath, string question) =>
        new(HttpMethod.Post, "/api/ask") { Content = JsonContent.Create(new AskRequest(basePath, question)) };

    /// <summary>Как окно: просьба заводится POST, а ход и итог читаются её потоком с начала.</summary>
    private static async Task<List<AskEvent>> Ask(HttpClient client, string basePath, string question)
    {
        using var started = await client.SendAsync(Post(basePath, question));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var body = await client.GetStringAsync("/api/agent/ask/stream?from=0");
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<AskEvent>(line, Json)!)
            .ToList();
    }

    private HttpClient Client(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и читает вывод.
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
        public Func<int, Task> BeforeLine { get; set; } = _ => Task.CompletedTask;
        public ProcessStartInfo? StartInfo { get; private set; }
        public string? Input { get; private set; }

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            Input = input;
            for (var i = 0; i < Lines.Count; i++)
            {
                await BeforeLine(i).WaitAsync(cancellationToken);
                await onLine(Lines[i]);
            }
            return Exit;
        }
    }
}
