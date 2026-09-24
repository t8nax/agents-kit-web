using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Performers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Чудо-Юдо придумывает исполнителя: панель зовёт агента в копии проекта, разбирает его ответ в поля
/// окна и ничего не пишет на диск. Настоящий claude в прогоне не запускается.
/// </summary>
public sealed class PerformerDraftEndpointsTests : IDisposable
{
    private const string Flow = """
        # App — сценарии

        ## полный
        1. [Ревью](stages/review.md)

        """;

    private const string Review = """
        # Ревью

        исполнитель: reviewer
        выход: вердикт по sha

        """;

    private const string Drafted = """
        ---
        name: reviewer
        description: Читает дифф ветки задачи и возвращает вердикт.
        tools: Read, Glob, Grep
        model: opus
        ---

        Ты читаешь дифф ветки целиком и возвращаешь вердикт.
        """;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-draft-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _copy;
    private readonly FakeAgent _agent = new();

    public PerformerDraftEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(_base);
        File.WriteAllText(
            Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = new[] { _copy } }));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
        Directory.CreateDirectory(Path.Combine(_base, "flow", "stages"));
        File.WriteAllText(Path.Combine(_base, "flow", "scenarios.md"), Flow.ReplaceLineEndings("\n"));
        File.WriteAllText(Path.Combine(_base, "flow", "stages", "review.md"), Review.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Draft_StreamsStepsAndFieldsOfPerformer()
    {
        _agent.Lines =
        [
            Tool("Glob", new { pattern = ".claude/agents/*.md" }),
            Result($"```markdown\n{Drafted}```"),
        ];

        var events = await Draft(await Client(), "Читает дифф ветки и возвращает вердикт");

        Assert.Equal(new PerformerDraftEvent("step", "ищет файлы .claude/agents/*.md"), events[0]);
        var drafted = events[1];
        Assert.Equal("drafted", drafted.Type);
        Assert.Equal("reviewer", drafted.Fields!.Name);
        Assert.Equal("Читает дифф ветки задачи и возвращает вердикт.", drafted.Fields.Description);
        Assert.Equal("opus", drafted.Fields.Model);
        Assert.Equal("Read, Glob, Grep", drafted.Fields.Tools);
        Assert.Equal("Ты читаешь дифф ветки целиком и возвращаешь вердикт.", drafted.Fields.Prompt);
        Assert.Equal(9200, drafted.DurationMs);
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task Draft_RunsReadOnlyClaudeInChosenCopyAndGivesItBaseAndFlow()
    {
        _agent.Lines = [Result(Drafted)];

        await Draft(await Client(), "--help, ревьюер ветки");

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        // Агент видит код проекта: он работает в копии, а не в каталоге базы.
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--permission-mode"));
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        // И базу: её путь стоит в системном промпте, а флоу приходит текстом в stdin.
        Assert.Contains(_base, args[args.IndexOf("--append-system-prompt") + 1]);
        Assert.Contains("--help, ревьюер ветки", _agent.Input);
        // Флоу уходит агенту файлами нынешнего вида кита: список сценариев и каждый этап.
        Assert.Contains("flow/scenarios.md:\n# App — сценарии", _agent.Input);
        Assert.Contains("flow/stages/review.md:\n# Ревью", _agent.Input);
        Assert.DoesNotContain("Нынешний исполнитель", _agent.Input);
    }

    [Fact]
    public async Task Draft_GivesAgentCurrentPerformerWhenItIsEdited()
    {
        _agent.Lines = [Result(Drafted)];
        var current = new PerformerDraftFields("reviewer", "Читает дифф.", "opus", "Read", "Ты читаешь дифф.");

        await Draft(await Client(), "Пусть ещё сверяет работу с критериями", current);

        Assert.Contains("Нынешний исполнитель", _agent.Input);
        Assert.Contains("name: reviewer", _agent.Input);
        Assert.Contains("Ты читаешь дифф.", _agent.Input);
        // Заведённого он правит, а не сочиняет нового: об этом сказано в системном промпте.
        var args = _agent.StartInfo!.ArgumentList.ToList();
        Assert.Contains("правит заведённого исполнителя", args[args.IndexOf("--append-system-prompt") + 1]);
    }

    [Fact]
    public async Task Draft_RemembersWhomItRewrites()
    {
        _agent.Lines = [Result(Drafted)];
        var client = await Client();
        var current = new PerformerDraftFields("reviewer", "Читает дифф.", "opus", "Read", "Ты читаешь дифф.");

        // Просьба о правке помнит, кого переписывает: её подхватывает окно правки reviewer, а не окно нового.
        using var edited = await client.SendAsync(Post(_base, "Пусть ещё сверяет", current));
        Assert.Equal("reviewer", (await edited.Content.ReadFromJsonAsync<AgentRequestSummary>(Json))!.Subject);
        var listed = await client.GetFromJsonAsync<List<AgentRequestSummary>>("/api/agent/requests", Json);
        Assert.Equal("reviewer", Assert.Single(listed!).Subject);

        // Просьба о новом — ни про кого.
        using var fresh = await client.SendAsync(Post(_base, "Ревьюер ветки", null));
        Assert.Null((await fresh.Content.ReadFromJsonAsync<AgentRequestSummary>(Json))!.Subject);
    }

    [Fact]
    public async Task Draft_WritesNothingToDisk()
    {
        _agent.Lines = [Result(Drafted)];

        var events = await Draft(await Client(), "Ревьюер ветки");

        Assert.Equal("drafted", events[^1].Type);
        Assert.False(Directory.Exists(Path.Combine(_copy, ".claude", "agents")));
        Assert.Equal(Flow.ReplaceLineEndings("\n"), await File.ReadAllTextAsync(Path.Combine(_base, "flow", "scenarios.md")));
    }

    [Fact]
    public async Task Draft_GoesOnWhenBaseHasNoFlow()
    {
        Directory.Delete(Path.Combine(_base, "flow"), recursive: true);
        _agent.Lines = [Result(Drafted)];

        var events = await Draft(await Client(), "Ревьюер ветки");

        Assert.Equal("drafted", events[^1].Type);
        Assert.DoesNotContain("Флоу проекта", _agent.Input);
    }

    [Fact]
    public async Task Draft_ReportsAnswerThatIsNotPerformer()
    {
        _agent.Lines = [Result("Готово, я придумал ревьюера.")];

        var events = await Draft(await Client(), "Ревьюер ветки");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("Чудо-Юдо вернул исполнителя без имени", error.Text);
        Assert.Equal("Готово, я придумал ревьюера.", error.Output);
    }

    [Fact]
    public async Task Draft_ReportsNameThatIsNotSubagentName()
    {
        _agent.Lines = [Result("---\nname: Ревьюер Ветки\n---\n\nТы читаешь дифф.\n")];

        var events = await Draft(await Client(), "Ревьюер ветки");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Contains("Ревьюер Ветки", error.Text);
    }

    [Fact]
    public async Task Draft_ReportsPerformerWithoutPrompt()
    {
        _agent.Lines = [Result("---\nname: reviewer\ndescription: Читает дифф.\n---\n")];

        var events = await Draft(await Client(), "Ревьюер ветки");

        var error = Assert.Single(events);
        Assert.Equal("Чудо-Юдо вернул не исполнителя: задания в его ответе нет", error.Text);
    }

    [Fact]
    public async Task Draft_ReportsAgentThatDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");

        var events = await Draft(await Client(), "Ревьюер ветки");

        var error = Assert.Single(events);
        Assert.Equal("Claude Code не запустился", error.Text);
        Assert.Equal("Не удаётся найти указанный файл", error.Output);
    }

    [Fact]
    public async Task Draft_RejectsBaseOutsideListAndEmptyWish()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = await Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Ревьюер"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        try
        {
            // Объекты git лежат read-only: без снятия атрибутов каталог прогона не удаляется.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
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

    private static HttpRequestMessage Post(
        string basePath, string wish, PerformerDraftFields? current = null) =>
        new(HttpMethod.Post, "/api/performers/draft")
        {
            Content = JsonContent.Create(new PerformerDraftRequest(basePath, wish, current)),
        };

    /// <summary>Как окно: просьба заводится POST, а ход и итог читаются её потоком с начала.</summary>
    private async Task<List<PerformerDraftEvent>> Draft(
        HttpClient client, string wish, PerformerDraftFields? current = null)
    {
        using var started = await client.SendAsync(Post(_base, wish, current));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var body = await client.GetStringAsync("/api/agent/performer/stream?from=0");
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<PerformerDraftEvent>(line, Json)!)
            .ToList();
    }

    private Task<HttpClient> Client() => Task.FromResult(
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
            });
        })).CreateClient());

    private sealed class FakeAgent : IAgentProcess
    {
        public IReadOnlyList<string> Lines { get; set; } = [];
        public AgentExit Exit { get; set; } = new(0, "");
        public ProcessStartInfo? StartInfo { get; private set; }
        public string Input { get; private set; } = "";

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            Input = input;
            foreach (var line in Lines)
                await onLine(line);
            return Exit;
        }
    }
}
