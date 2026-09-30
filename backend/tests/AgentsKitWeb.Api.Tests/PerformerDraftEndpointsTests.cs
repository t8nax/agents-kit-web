using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Performers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Переписка с Чудо-Юдо об исполнителе — B-320: панель зовёт агента в копии проекта, разбирает предложенного им
/// исполнителя и ничего не пишет на диск. Настоящий claude в прогоне не запускается.
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

    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly PerformerDraftFields Reviewer = new(
        "reviewer", "Читает дифф ветки задачи и возвращает вердикт.", "opus", "Read, Glob, Grep",
        "Ты читаешь дифф ветки целиком и возвращаешь вердикт.");

    private readonly string _root = Directory.CreateTempSubdirectory("akw-draft-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _copy;
    private readonly TestChat _agent = new();

    public PerformerDraftEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _copy);
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
        Directory.CreateDirectory(Path.Combine(TestLayout.Personal(_base), "flow", "stages"));
        File.WriteAllText(Path.Combine(TestLayout.Personal(_base), "flow", "scenarios.md"), Flow.ReplaceLineEndings("\n"));
        File.WriteAllText(Path.Combine(TestLayout.Personal(_base), "flow", "stages", "review.md"), Review.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Answer_WithPerformerBlock_ProposesItWithChangedFields()
    {
        _agent.Answers = [[
            Tool("Glob", new { pattern = ".claude/agents/*.md" }),
            Result($"Вот ревьюер.\n\n{PerformerDraftEndpoints.Marker}\n```markdown\n{Drafted}```"),
        ]];
        var client = Client();

        await Start(client, "Читает дифф ветки и возвращает вердикт");
        var events = await Read(client, 3);

        Assert.Equal(new PerformerDraftEvent("reply", "Читает дифф ветки и возвращает вердикт"), events[0]);
        Assert.Equal("step", events[1].Type);
        Assert.Equal("ищет файлы .claude/agents/*.md", events[1].Text);
        var answer = events[2];
        Assert.Equal("answer", answer.Type);
        Assert.Equal("Вот ревьюер.", answer.Text);
        Assert.Equal(Reviewer, answer.Proposal);
        Assert.Equal(PerformerDraftEndpoints.Fields, answer.Changed);
        Assert.Equal(9200, answer.DurationMs);
    }

    [Fact]
    public async Task Start_RunsReadOnlyConversationInMainCopyAndGivesItBaseAndFlow()
    {
        _agent.Answers = [[Result("Что он проверяет?")]];
        var client = Client();

        await Start(client, "--help, ревьюер ветки");
        var answer = (await Read(client, 2))[1];

        Assert.Equal("answer", answer.Type);
        Assert.Equal("Что он проверяет?", answer.Text);
        Assert.Null(answer.Proposal);
        var startInfo = Assert.Single(_agent.Starts);
        Assert.Equal("claude", startInfo.FileName);
        // Агент видит код проекта: он работает в копии, а не в каталоге базы.
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("stream-json", args[args.IndexOf("--input-format") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        // Режим «авто» задан явно, а указание работать через оболочку погашено — B-153.
        Assert.Equal("auto", args[args.IndexOf("--permission-mode") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains(_base, prompt);
        Assert.Contains("Это переписка", prompt);
        // Исполнители и флоу — в личном репозитории оператора этой машины (формат 6 кита).
        Assert.Contains($"в каталоге {TestLayout.Agents(_base)},", prompt);
        Assert.Contains($"репозитории оператора {TestLayout.Personal(_base)} — его флоу", prompt);
        var input = Text(_agent.Input[0]);
        Assert.StartsWith("Просьба оператора:\n--help, ревьюер ветки", input);
        // Флоу уходит агенту файлами нынешнего вида кита: список сценариев и каждый этап.
        Assert.Contains("flow/scenarios.md:\n# App — сценарии", input);
        Assert.Contains("flow/stages/review.md:\n# Ревью", input);
        Assert.EndsWith("Поля нового исполнителя в окне сейчас:\nпусто — исполнитель заводится.", input);
    }

    /// <summary>Каждая реплика несёт поля, какими они стоят в окне: поправленное руками агент видит, и у нового тоже.</summary>
    [Fact]
    public async Task Reply_ContinuesSameAgentWithFieldsAsInWindow()
    {
        _agent.Answers = [[Result("Какую модель?")], [Result($"Готово.\n{PerformerDraftEndpoints.Marker}\n{Drafted}")]];
        var client = Client();
        await Start(client, "Ревьюер ветки", Reviewer with { Name = "", Prompt = "Руками: читай дифф." });
        await Read(client, 2);

        var reply = await client.PostAsJsonAsync(
            "/api/performers/draft/reply", new PerformerDraftReply("opus", Reviewer with { Description = "Руками поправил." }));
        var events = await Read(client, 4);

        Assert.Equal(HttpStatusCode.NoContent, reply.StatusCode);
        Assert.Contains("Руками: читай дифф.", Text(_agent.Input[0]));
        var input = Text(_agent.Input[1]);
        Assert.StartsWith("Оператор:\nopus", input);
        Assert.Contains("description: Руками поправил.", input);
        // Флоу знает живой агент с первой реплики: второй раз он не уходит.
        Assert.DoesNotContain("flow/scenarios.md", input);
        Assert.Single(_agent.Starts);
        Assert.Equal(new PerformerDraftEvent("reply", "opus"), events[2]);
        // Ответ сверяется с тем, что стояло в окне к реплике: поменялось только описание.
        Assert.Equal(["description"], events[3].Changed);
    }

    [Fact]
    public async Task Start_ForEditedPerformer_RemembersWhomItRewritesAndTellsAgent()
    {
        _agent.Answers = [[Result("Понял.")]];
        var client = Client();

        using var edited = await client.PostAsJsonAsync(
            "/api/performers/draft", new PerformerDraftRequest(_base, "Пусть ещё сверяет", Reviewer, "reviewer"));
        await Read(client, 2);

        // Переписка о правке помнит, кого переписывает: её подхватывает окно правки reviewer, а не окно нового.
        Assert.Equal("reviewer", (await edited.Content.ReadFromJsonAsync<AgentRequestSummary>(Json))!.Subject);
        var listed = await client.GetFromJsonAsync<List<AgentRequestSummary>>("/api/agent/requests", Json);
        Assert.Equal("reviewer", Assert.Single(listed!).Subject);
        Assert.Contains("Исполнитель в окне сейчас:\n---\nname: reviewer", Text(_agent.Input[0]));
        var args = Assert.Single(_agent.Starts).ArgumentList.ToList();
        Assert.Contains("правит заведённого исполнителя", args[args.IndexOf("--append-system-prompt") + 1]);

        // Переписка о новом — ни про кого.
        using var fresh = await client.PostAsJsonAsync("/api/performers/draft", new PerformerDraftRequest(_base, "Ревьюер ветки"));
        Assert.Null((await fresh.Content.ReadFromJsonAsync<AgentRequestSummary>(Json))!.Subject);
    }

    [Fact]
    public async Task Answer_WritesNothingToDisk()
    {
        _agent.Answers = [[Result($"{PerformerDraftEndpoints.Marker}\n{Drafted}")]];
        var client = Client();

        await Start(client, "Ревьюер ветки");
        var events = await Read(client, 2);

        Assert.Equal(Reviewer, events[^1].Proposal);
        Assert.False(Directory.Exists(Path.Combine(_copy, ".claude", "agents")));
        Assert.Equal(Flow.ReplaceLineEndings("\n"), await File.ReadAllTextAsync(Path.Combine(TestLayout.Personal(_base), "flow", "scenarios.md")));
    }

    [Fact]
    public async Task Start_GoesOnWhenBaseHasNoFlow()
    {
        Directory.Delete(Path.Combine(TestLayout.Personal(_base), "flow"), recursive: true);
        _agent.Answers = [[Result("ok")]];
        var client = Client();

        await Start(client, "Ревьюер ветки");
        await Read(client, 2);

        Assert.DoesNotContain("Флоу оператора", Text(_agent.Input[0]));
    }

    /// <summary>Исполнителя, которого панель не разберёт, она один раз возвращает агенту на доработку.</summary>
    [Fact]
    public async Task Answer_WithoutName_GoesBackForReworkOnce()
    {
        _agent.Answers = [
            [Result($"Вот.\n{PerformerDraftEndpoints.Marker}\n---\ndescription: Читает дифф.\n---\n\nТы читаешь дифф.\n")],
            [Result($"Исправил.\n{PerformerDraftEndpoints.Marker}\n{Drafted}")],
        ];
        var client = Client();

        await Start(client, "Ревьюер ветки");
        var events = await Read(client, 3);

        Assert.Equal("rework", events[1].Type);
        Assert.Contains("Исполнитель без имени", events[1].Text);
        Assert.Contains("Панель не приняла твой ответ", Text(_agent.Input[1]));
        Assert.Equal("answer", events[2].Type);
        Assert.Equal(Reviewer, events[2].Proposal);
    }

    [Fact]
    public async Task Answer_BadTwice_IsErrorWithAgentWords()
    {
        var broken = $"Вот.\n{PerformerDraftEndpoints.Marker}\n---\nname: Ревьюер Ветки\n---\n\nТы читаешь дифф.\n";
        _agent.Answers = [[Result(broken)], [Result(broken)]];
        var client = Client();

        await Start(client, "Ревьюер ветки");
        var events = await Read(client, 3);

        Assert.Equal("error", events[2].Type);
        Assert.Contains("«Ревьюер Ветки»", events[2].Text);
        Assert.Equal(broken, events[2].Output);
    }

    [Fact]
    public async Task Answer_PerformerWithoutPrompt_IsReworked()
    {
        _agent.Answers = [[Result($"{PerformerDraftEndpoints.Marker}\n---\nname: reviewer\n---\n")]];
        var client = Client();

        await Start(client, "Ревьюер ветки");
        var events = await Read(client, 2);

        Assert.Equal("rework", events[1].Type);
        Assert.Contains("Исполнитель без задания", events[1].Text);
    }

    [Fact]
    public async Task Start_ReportsAgentThatDidNotStart()
    {
        _agent.StopAfter = 0;
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = Client();

        await Start(client, "Ревьюер ветки");
        var events = await Read(client, 2);

        Assert.Equal("error", events[1].Type);
        Assert.Equal("Claude Code не запустился", events[1].Text);
        Assert.Equal("Не удаётся найти указанный файл", events[1].Output);
    }

    [Fact]
    public async Task Start_RejectsBaseOutsideListAndEmptyWish()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/performers/draft", new PerformerDraftRequest(other, "Ревьюер"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/performers/draft", new PerformerDraftRequest(_base, "  "))).StatusCode);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Reply_WithoutConversation_IsNotFound()
    {
        var client = Client();

        var reply = await client.PostAsJsonAsync("/api/performers/draft/reply", new PerformerDraftReply("ещё"));

        Assert.Equal(HttpStatusCode.NotFound, reply.StatusCode);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root, () =>
        {
            // Объекты git лежат read-only: без снятия атрибутов каталог прогона не удаляется.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
        });
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

    private static string Text(string line) =>
        JsonDocument.Parse(line).RootElement.GetProperty("message").GetProperty("content")[0].GetProperty("text").GetString()!;

    private async Task Start(HttpClient client, string wish, PerformerDraftFields? current = null)
    {
        using var started = await client.PostAsJsonAsync("/api/performers/draft", new PerformerDraftRequest(_base, wish, current));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
    }

    /// <summary>Как окно: переписка заводится POST, а ход и ответы читаются её потоком с начала.</summary>
    private static async Task<List<PerformerDraftEvent>> Read(HttpClient client, int count)
    {
        using var response = await client.GetAsync("/api/agent/performer/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var events = new List<PerformerDraftEvent>();
        while (events.Count < count)
        {
            var line = await reader.ReadLineAsync().WaitAsync(Wait);
            Assert.NotNull(line);
            if (line.Trim().Length > 0)
                events.Add(JsonSerializer.Deserialize<PerformerDraftEvent>(line, Json)!);
        }
        return events;
    }

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
                services.RemoveAll<IAgentChat>();
                services.AddSingleton<IAgentChat>(_agent);
            });
        })).CreateClient();
}
