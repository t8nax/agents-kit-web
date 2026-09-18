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

public sealed class BacklogWriteEndpointsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const string Backlog = """
        # Order Service — бэклог

        следующий номер: B-2

        ## B-1 Старая запись

        Текст старой записи.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-backlog-write-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly FakeAgent _agent = new();

    /// <summary>Команда коммита, которую панель диктует агенту и кладёт в правило разрешения.</summary>
    private string Commit => $"git -C \"{_base}\" commit -m \"{BacklogWriteEndpoints.CommitMessage}\" -- backlog.md";

    public BacklogWriteEndpointsTests()
    {
        _copy = Path.Combine(_root, "app");
        Directory.CreateDirectory(Path.Combine(_copy, "frontend", "src"));
        _base = TestGit.Repository(Path.Combine(_root, "app-knowledge"));
        TestGit.Run(_base, "config", "user.name", "t");
        TestGit.Run(_base, "config", "user.email", "t@t");
        TestGit.Run(_base, "config", "core.autocrlf", "false");
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), JsonSerializer.Serialize(new { workspaces = new[] { _copy } }));
        File.WriteAllText(Path.Combine(_base, "backlog.md"), Backlog.ReplaceLineEndings("\n") + "\n");
        TestGit.Run(_base, "add", "agents-kit.json", "backlog.md");
        TestGit.Run(_base, "commit", "-m", "base");
    }

    [Fact]
    public async Task Write_StreamsStepsAndReportsNewCommittedEntries()
    {
        _agent.Lines =
        [
            Tool("Read", new { file_path = @"C:\Users\op\.claude\skills\agents-kit\reference\backlog-record.md" }),
            Tool("Grep", new { pattern = "Waiting", path = Path.Combine(_copy, "frontend", "src") }),
            Tool("Edit", new { file_path = Path.Combine(_base, "backlog.md") }),
            Tool("PowerShell", new { command = Commit }),
            """{"type":"result","subtype":"success","is_error":false,"duration_ms":41000,"result":"Записал B-2 и B-3."}""",
        ];
        _agent.BeforeLine = index =>
        {
            if (index == 4)
            {
                AppendEntries(next: "B-4", "## B-2 Таблица показывает ожидание\n\nСколько копия ждёт.\n\n### Агенту\n- где: App.tsx", "## B-3 Сортировка по номеру");
                TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            }
            return Task.CompletedTask;
        };

        var events = await Write(Client(_base), _base, "Хочу видеть ожидание и сортировку");

        Assert.Equal(
            [
                new BacklogWriteEvent("step", "читает backlog-record.md"),
                new BacklogWriteEvent("step", "ищет «Waiting» в frontend/src"),
                new BacklogWriteEvent("step", "правит backlog.md"),
                new BacklogWriteEvent("step", "коммитит бэклог"),
            ],
            events.Take(4));
        var written = events[4];
        Assert.Equal("written", written.Type);
        Assert.Equal(
            [new BacklogEntry("B-2", "Таблица показывает ожидание", "Сколько копия ждёт."), new BacklogEntry("B-3", "Сортировка по номеру", null)],
            written.Entries);
        Assert.Equal(Git("log", "-1", "--format=%h"), written.Commit);
        Assert.Equal(41000, written.DurationMs);
        Assert.Equal(5, events.Count);
    }

    [Fact]
    public async Task Write_RunsClaudeInProjectCopyWithBacklogSkillAndOnlyBacklogPermissions()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":false,"result":"ok"}"""];

        await Write(Client(_base), _base, "  --help и мысль  ");

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal("/agents-kit:backlog --help и мысль", _agent.Input);

        var args = startInfo.ArgumentList.ToList();
        Assert.Contains("-p", args);
        Assert.Equal("Read,Grep,Glob,Edit,PowerShell,Skill", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("dontAsk", args[args.IndexOf("--permission-mode") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        var allowed = args.Skip(args.IndexOf("--allowedTools") + 1).TakeWhile(a => !a.StartsWith("--")).ToList();
        Assert.Equal(
            ["Read", "Grep", "Glob", "Skill", $"Edit({Path.Combine(_base, "backlog.md")})", $"PowerShell({Commit})"],
            allowed);
        // Правило пускает команду, только когда она записана целиком, поэтому промпт диктует её слово в слово.
        Assert.Contains(Commit, args[args.IndexOf("--append-system-prompt") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        Assert.DoesNotContain(args, a => a.Contains("dangerously", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(args, a => a.Contains("bypassPermissions", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Write_ReportsAgentThatAddedNothing()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":false,"result":"Правка запрещена, ничего не записал."}"""];

        var events = await Write(Client(_base), _base, "Мысль");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("Агент закончил, но новых записей в бэклоге нет", error.Text);
        Assert.Equal("Правка запрещена, ничего не записал.", error.Output);
    }

    [Fact]
    public async Task Write_ReportsEntriesLeftUncommitted()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":false,"result":"Коммит отклонён сверкой."}"""];
        _agent.BeforeLine = _ =>
        {
            AppendEntries(next: "B-3", "## B-2 Новая запись");
            return Task.CompletedTask;
        };

        var events = await Write(Client(_base), _base, "Мысль");

        var error = Assert.Single(events);
        Assert.Equal("Записи появились, но backlog.md не закоммичен", error.Text);
        Assert.Equal([new BacklogEntry("B-2", "Новая запись", null)], error.Entries);
        Assert.Equal("Коммит отклонён сверкой.", error.Output);
    }

    [Fact]
    public async Task Write_ReportsAgentErrorWithItsText()
    {
        _agent.Lines = ["""{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"""];
        _agent.Exit = new AgentExit(1, "");

        var events = await Write(Client(_base), _base, "Мысль");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("Invalid API key · Please run /login", error.Output);
        Assert.Null(error.Entries);
    }

    [Fact]
    public async Task Write_DoesNotStartOverUncommittedBacklogEdit()
    {
        File.AppendAllText(Path.Combine(_base, "backlog.md"), "\nчужая правка\n");

        var events = await Write(Client(_base), _base, "Мысль");

        Assert.Equal("В backlog.md базы есть незакоммиченная правка — запись не начата", Assert.Single(events).Text);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Write_DoesNotStartWithoutProjectCopyOnDisk()
    {
        Directory.Delete(_copy, recursive: true);

        var events = await Write(Client(_base), _base, "Мысль");

        Assert.Equal("error", Assert.Single(events).Type);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Write_RejectsBaseOutsideListAndEmptyText()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client(_base);

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Мысль"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
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

    private void AppendEntries(string next, params string[] entries)
    {
        var file = Path.Combine(_base, "backlog.md");
        var text = File.ReadAllText(file).Replace("следующий номер: B-2", $"следующий номер: {next}");
        File.WriteAllText(file, text + "\n" + string.Join("\n\n", entries) + "\n");
    }

    private string Git(params string[] args)
    {
        var startInfo = new ProcessStartInfo("git") { WorkingDirectory = _base, RedirectStandardOutput = true };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return output;
    }

    private static string Tool(string name, object input) => JsonSerializer.Serialize(new
    {
        type = "assistant",
        message = new { content = new object[] { new { type = "tool_use", name, input } } },
    });

    private static HttpRequestMessage Post(string basePath, string text) =>
        new(HttpMethod.Post, "/api/backlog/write") { Content = JsonContent.Create(new BacklogWriteRequest(basePath, text)) };

    /// <summary>Как окно: просьба заводится POST, а ход и итог читаются её потоком с начала.</summary>
    private static async Task<List<BacklogWriteEvent>> Write(HttpClient client, string basePath, string text)
    {
        using var started = await client.SendAsync(Post(basePath, text));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var body = await client.GetStringAsync("/api/agent/backlog/stream?from=0");
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<BacklogWriteEvent>(line, Json)!)
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
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и что выводит из базы.
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
