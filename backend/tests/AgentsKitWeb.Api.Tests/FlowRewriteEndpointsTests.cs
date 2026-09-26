using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowRewriteEndpointsTests : IDisposable
{
    private const string Rules = """
        # Флоу: сценарии и этапы

        ## Сценарий

        Сценарии — flow/scenarios.md.

        ## Этап

        Ключи — закрытый перечень: исполнитель, выход, пропуск.

        ## Чего во флоу нет

        Инвариантов кита во флоу нет.

        ## Находки сверки

        Два флоу с одним именем.
        """;

    private const string Reviewer = """
        ---
        name: reviewer
        description: Вычитывает дифф ветки задачи
        ---

        Ты читаешь дифф ветки целиком и возвращаешь вердикт.
        """;

    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    private static readonly FlowStage Review = new(
        "Ревью", "reviewer", "вердикт по sha", "правка только в текстах", "1. Собрать дифф.", Slug: "review");

    private static readonly FlowStage Merge = new("Мерж", "оркестратор", "sha в dev", null, null, Slug: "merge");

    private static readonly NamedFlow Big = new(
        "Крупные", "много работы",
        [new FlowEntry("Ревью"), new FlowEntry("Мерж", [new StageReturn("dev ушёл", "Ревью")])]);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-rewrite-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _copy;
    private readonly string _kit;
    private readonly TestChat _agent = new();

    public FlowRewriteEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "agents"));
        File.WriteAllText(
            Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = new[] { _copy } }));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        File.WriteAllText(Path.Combine(_base, "agents", "reviewer.md"), Reviewer.ReplaceLineEndings("\n"));

        _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        var rules = FlowRules.File(_kit);
        Directory.CreateDirectory(Path.GetDirectoryName(rules)!);
        File.WriteAllText(rules, Rules.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Rewrite_PutsWishStepsAndAnswerIntoConversation()
    {
        _agent.Answers =
        [
            [
                Tool("Read", new { file_path = Path.Combine(_copy, "README.md") }),
                Result("Документация нужна в обоих сценариях?"),
            ],
        ];
        var client = await Client();

        await Start(client, "Добавь документацию");
        var events = await Read(client, 3);

        Assert.Equal(new FlowRewriteEvent("reply", "Добавь документацию"), events[0]);
        Assert.Equal("step", events[1].Type);
        Assert.Equal("answer", events[2].Type);
        Assert.Equal("Документация нужна в обоих сценариях?", events[2].Text);
        Assert.Equal(9200, events[2].DurationMs);
    }

    [Fact]
    public async Task Rewrite_RunsReadOnlyConversationInMainCopyWithKitRules()
    {
        _agent.Answers = [[Result("ok")]];
        var client = await Client();

        await Start(client, "--help, напиши этап документации");
        await Read(client, 2);

        var startInfo = Assert.Single(_agent.Starts);
        Assert.Equal("claude", startInfo.FileName);
        // Агент читает код проекта: работает он в основной копии, а базу видит по её пути.
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("stream-json", args[args.IndexOf("--input-format") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--permission-mode"));
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        // Правила формы сценария и этапа агент получает из справки кита, а не своими словами панели.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains(_base, prompt);
        Assert.Contains("Сценарии — flow/scenarios.md.", prompt);
        Assert.Contains("Ключи — закрытый перечень: исполнитель, выход, пропуск.", prompt);
        Assert.Contains("Инвариантов кита во флоу нет.", prompt);
        Assert.DoesNotContain("Два флоу с одним именем.", prompt);
        var sent = Assert.Single(_agent.Input);
        Assert.Equal("user", JsonDocument.Parse(sent).RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Rewrite_LetsAgentAskAndMendWhatTheWishTouched()
    {
        _agent.Answers = [[Result("ok")]];
        var client = await Client();

        await Start(client, "Добавь документацию");
        await Read(client, 2);

        var args = _agent.Starts[0].ArgumentList.ToList();
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        // Прежний запрет «меняй только то, о чём просит оператор» снят (B-116 в B-242): задетое приводится в связный вид.
        Assert.DoesNotContain("Меняй только то, о чём просит оператор", prompt);
        Assert.Contains("поправь и его, даже если о нём", prompt);
        Assert.Contains("спроси или скажи об этом", prompt);
    }

    [Fact]
    public async Task Rewrite_AsksAgentForWholeStagesWithPerformerAndOutput()
    {
        _agent.Answers = [[Result("ok")]];
        var client = await Client();

        await Start(client, "Поправь описание ревью");
        await Read(client, 2);

        var args = _agent.Starts[0].ArgumentList.ToList();
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        // Агент возвращал этап без выхода, когда менял одну строку (B-256): полный этап требуется прямо.
        Assert.Contains("исполнитель и выход всегда", prompt);
        Assert.Contains("даже если меняется одно слово", prompt);
        Assert.Contains("каждый целиком, а не одни поменявшиеся строки", prompt);
    }

    [Fact]
    public async Task Rewrite_GivesWholeFlowTasksAndPerformersInFirstReply()
    {
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(
            Path.Combine(_base, "work", "d-app-task.md"),
            "# Поправить вход\nрабочая копия: D:\\app-task\nсценарий: Крупные\n");
        _agent.Answers = [[Result("ok")]];
        var client = await Client();

        await Start(client, "Добавь документацию", [Review, Merge], [Big]);
        await Read(client, 2);

        var input = Text(Assert.Single(_agent.Input));
        Assert.StartsWith("Просьба оператора:\nДобавь документацию", input);
        // Сценарии — в форме scenarios.md, этапы — файлами целиком: агент видит флоу таким, как на экране.
        Assert.Contains(
            "## Крупные\nкогда: много работы\n1. [Ревью](stages/review.md)\n2. [Мерж](stages/merge.md)\n   - возврат: dev ушёл — этап «Ревью»",
            input);
        Assert.Contains("=== stages/review.md\n# Ревью\n\nисполнитель: reviewer\nвыход: вердикт по sha", input);
        Assert.Contains("=== stages/merge.md\n# Мерж", input);
        Assert.Contains("- Поправить вход: идёт по сценарию «Крупные» — его и его этапы панель не запишет", input);
        Assert.Contains("- reviewer — Вычитывает дифф ветки задачи", input);
    }

    [Fact]
    public async Task Reply_GoesToSameAgentAsNextLine()
    {
        _agent.Answers = [[Result("В обоих сценариях?")], [Result("Понял.")]];
        var client = await Client();

        await Start(client, "Добавь документацию", [Review], [Big]);
        await Read(client, 2);
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "В обоих")).StatusCode);
        var events = await Read(client, 4);

        Assert.Equal(new FlowRewriteEvent("reply", "В обоих"), events[2]);
        Assert.Equal("Понял.", events[3].Text);
        Assert.Single(_agent.Starts);
        // Следующая реплика уходит агенту своими словами: флоу он уже знает.
        Assert.Equal("В обоих", Text(_agent.Input[1]));
    }

    [Fact]
    public async Task Reply_AfterAgentEnded_StartsNewAgentWithFlowAsItIsNow()
    {
        _agent.StopAfter = 1;
        _agent.Answers = [[Result("В обоих сценариях?")], [Result("Понял.")]];
        var client = await Client();

        await Start(client, "Добавь документацию", [Review], [Big]);
        await Read(client, 2);
        // Оператор записал правку: новый агент получает флоу таким, каким он стал к реплике.
        var renamed = Review with { Title = "Проверка" };
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "В обоих", [renamed], [])).StatusCode);
        var events = await Read(client, 5);

        Assert.Equal("note", events[2].Type);
        Assert.Equal(new FlowRewriteEvent("reply", "В обоих"), events[3]);
        Assert.Equal(2, _agent.Starts.Count);
        var input = Text(_agent.Input[1]);
        Assert.StartsWith("Просьба оператора:\nВ обоих", input);
        Assert.Contains("# Проверка", input);
    }

    [Fact]
    public async Task Answers_AccumulateProposalAndCountWhatEachChanged()
    {
        _agent.Answers =
        [
            [Result("Завёл документацию.\n=== новый этап\n# Документация\n\nисполнитель: оркестратор\nвыход: раздел\n")],
            [Result("Ревью смотрит и тесты.\n=== этап «Ревью»\n# Ревью\n\nисполнитель: reviewer\nвыход: вердикт и тесты\n")],
            [Result("Какие именно тесты?")],
        ];
        var client = await Client();

        await Start(client, "Добавь документацию", [Review, Merge], [Big]);
        await Read(client, 2);
        await Reply(client, "И пусть ревью смотрит тесты", [Review, Merge], [Big]);
        await Read(client, 4);
        await Reply(client, "Все", [Review, Merge], [Big]);
        var events = await Read(client, 6);

        Assert.Equal("Завёл документацию.", events[1].Text);
        Assert.Equal(new FlowChanged(0, 1), events[1].Changed);
        // Второй ответ несёт все правки переписки, а считает только свою.
        var second = events[3];
        Assert.Equal(new FlowChanged(0, 1), second.Changed);
        Assert.Equal([null, "Ревью"], second.Proposal!.Stages.Select(s => s.Of));
        // Ответ-вопрос правок не трогает и ничего не считает.
        Assert.Null(events[5].Changed);
        Assert.Equal(2, events[5].Proposal!.Stages.Count);
    }

    [Fact]
    public async Task Reply_DropsChangesOperatorHasWritten()
    {
        _agent.Answers =
        [
            [Result("=== новый этап\n# Документация\n\nисполнитель: оркестратор\nвыход: раздел\n")],
            [Result("Хорошо.")],
        ];
        var client = await Client();

        await Start(client, "Добавь документацию", [Review], []);
        await Read(client, 2);
        // «Принять правки» записали этап: экран его держит, и из правок он уходит.
        var docs = new FlowStage("Документация", "оркестратор", "раздел", null, null, Slug: "docs");
        await Reply(client, "Спасибо", [Review, docs], []);
        var events = await Read(client, 4);

        Assert.Empty(events[3].Proposal!.Stages);
    }

    [Fact]
    public async Task Answer_ThatWriteWouldNotAccept_IsErrorWithAgentWords()
    {
        _agent.Answers = [[Result("=== этап «Сборка»\n# Сборка\n\nисполнитель: оператор\nвыход: есть\n")]];
        var client = await Client();

        await Start(client, "Поправь сборку", [Review], []);
        var events = await Read(client, 2);

        Assert.Equal("error", events[1].Type);
        Assert.Equal("Чудо-Юдо предложил правку этапа «Сборка», которого во флоу нет", events[1].Text);
        Assert.StartsWith("=== этап «Сборка»", events[1].Output);
    }

    [Fact]
    public async Task Stop_BreaksAnswerButKeepsConversation()
    {
        var gate = new TaskCompletionSource();
        _agent.Answers = [[Result("не дойдёт")]];
        _agent.BeforeLine = _ => gate.Task;
        var client = await Client();

        await Start(client, "Добавь документацию");
        await Until(async () => (await client.PostAsync("/api/flow/rewrite/stop", null)).StatusCode == HttpStatusCode.NoContent);
        var events = await Read(client, 2);

        Assert.Equal("stopped", events[1].Type);
        Assert.True(await _agent.CancelledWithin(Wait));
    }

    [Fact]
    public async Task Rewrite_WithoutMainCopy_RunsInBase()
    {
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        _agent.Answers = [[Result("ok")]];
        var client = await Client();

        await Start(client, "Напиши этап документации");
        await Read(client, 2);

        Assert.Equal(_base, _agent.Starts[0].WorkingDirectory);
        Assert.DoesNotContain("--add-dir", _agent.Starts[0].ArgumentList);
    }

    [Fact]
    public async Task Rewrite_LeavesBaseAsItWas()
    {
        _agent.Answers = [[Result("=== новый этап\n# Документация\n\nисполнитель: оператор\nвыход: раздел\n")]];
        var client = await Client();

        await Start(client, "Напиши этап");
        await Read(client, 2);

        Assert.False(Directory.Exists(Path.Combine(_base, "flow")));
    }

    [Fact]
    public async Task Rewrite_WithoutKitRules_DoesNotRunAgent()
    {
        var client = await Client(withKit: false);

        using var response = await client.SendAsync(Post(_base, "Напиши этап"));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<FlowRewriteEvent>(Json))!;
        Assert.Contains("правила формы этапа", error.Text);
        Assert.Contains(FlowRules.RulesFile, error.Text);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Rewrite_ReportsAgentThatDidNotStart()
    {
        _agent.StopAfter = 0;
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = await Client();

        await Start(client, "Напиши этап");
        var events = await Read(client, 2);

        Assert.Equal("Claude Code не запустился", events[1].Text);
        Assert.Equal("Не удаётся найти указанный файл", events[1].Output);
    }

    [Fact]
    public async Task Rewrite_RejectsBaseOutsideListEmptyWishAndReplyWithoutConversation()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = await Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Напиши этап"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Reply(client, "ещё")).StatusCode);
        Assert.Empty(_agent.Starts);
    }

    [Theory]
    [InlineData("```markdown\n# Флоу\n```", "# Флоу\n")]
    [InlineData("```\n# Флоу\n```", "# Флоу\n")]
    [InlineData("# Флоу\n", "# Флоу\n")]
    [InlineData("```не закрыто", "```не закрыто")]
    public void Unfence_StripsFenceAroundFileText(string answer, string expected) =>
        Assert.Equal(expected, FlowRewriteEndpoints.Unfence(answer));

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

    /// <summary>Текст реплики, ушедшей агенту строкой stream-json.</summary>
    private static string Text(string line) =>
        JsonDocument.Parse(line).RootElement.GetProperty("message").GetProperty("content")[0].GetProperty("text").GetString()!;

    private static HttpRequestMessage Post(string basePath, string wish, FlowStage[]? stages = null, NamedFlow[]? flows = null) =>
        new(HttpMethod.Post, "/api/flow/rewrite")
        {
            Content = JsonContent.Create(new FlowRewriteRequest(basePath, wish, stages ?? [], flows ?? [])),
        };

    private async Task Start(HttpClient client, string wish, FlowStage[]? stages = null, NamedFlow[]? flows = null)
    {
        using var started = await client.SendAsync(Post(_base, wish, stages, flows));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
    }

    private static Task<HttpResponseMessage> Reply(
        HttpClient client, string text, FlowStage[]? stages = null, NamedFlow[]? flows = null) =>
        client.PostAsJsonAsync("/api/flow/rewrite/reply", new FlowRewriteReply(text, stages, flows));

    /// <summary>Как окно: переписка читается потоком просьбы с начала и ждёт следующих событий в нём же.</summary>
    private static async Task<List<FlowRewriteEvent>> Read(HttpClient client, int count)
    {
        using var response = await client.GetAsync("/api/agent/flow/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var events = new List<FlowRewriteEvent>();
        while (events.Count < count)
        {
            var line = await reader.ReadLineAsync().WaitAsync(Wait);
            Assert.NotNull(line);
            if (line.Trim().Length > 0)
                events.Add(JsonSerializer.Deserialize<FlowRewriteEvent>(line, Json)!);
        }
        return events;
    }

    private static async Task Until(Func<Task<bool>> condition)
    {
        using var deadline = new CancellationTokenSource(Wait);
        while (!await condition())
            await Task.Delay(20, deadline.Token);
    }

    private async Task<HttpClient> Client(bool withKit = true)
    {
        var client = _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и читает вывод.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentChat>();
                services.AddSingleton<IAgentChat>(_agent);
            });
        })).CreateClient();

        if (withKit)
            (await client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
        return client;
    }
}
