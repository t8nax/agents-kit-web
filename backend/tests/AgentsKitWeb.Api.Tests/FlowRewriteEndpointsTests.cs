using System.Diagnostics;
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

        ## Флоу

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

    private static readonly FlowStage Review = new(
        "Ревью", "reviewer", "вердикт по sha", "правка только в текстах", "1. Собрать дифф.", Slug: "review");

    private static readonly FlowStage Merge = new("Мерж", "оркестратор", "sha в dev", null, null, Slug: "merge");

    private const string NewDocs = "=== новый этап\n# Документация\n\nисполнитель: оператор\nвыход: раздел\n";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-rewrite-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _kit;
    private readonly FakeAgent _agent = new();

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
    public async Task Rewrite_StreamsStepsAndRewrittenStageOfContext()
    {
        _agent.Lines =
        [
            Tool("Read", new { file_path = Path.Combine(_copy, "README.md") }),
            Result("""
                ```markdown
                === этап «Ревью»
                # Ревью

                исполнитель: reviewer
                выход: вердикт по sha проверенного коммита
                пропуск: правка только в текстах

                1. Собрать дифф всей ветки.
                ```
                """.ReplaceLineEndings("\n")),
        ];
        var client = await Client();

        var events = await Rewrite(client, "Уточни выход ревью", [Review], ["Ревью", "Мерж"]);

        Assert.Equal("step", events[0].Type);
        var rewritten = events[1];
        Assert.Equal("rewritten", rewritten.Type);
        var stage = Assert.Single(rewritten.Stages!);
        Assert.Equal("Ревью", stage.Of);
        Assert.Equal(
            new FlowStage("Ревью", "reviewer", "вердикт по sha проверенного коммита", "правка только в текстах",
                "1. Собрать дифф всей ветки.", Slug: "review"),
            stage.Stage);
        Assert.Equal(9200, rewritten.DurationMs);
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task Rewrite_RequestRemembersContextStages()
    {
        _agent.Lines = [Result(NewDocs)];
        var client = await Client();

        await Rewrite(client, "Уточни выход ревью", [Review, Merge], ["Ревью", "Мерж"]);

        // Открытое заново окно берёт этапы просьбы из списка панели: само оно их не помнит.
        var listed = await client.GetFromJsonAsync<List<AgentRequestSummary>>("/api/agent/requests", Json);
        var request = Assert.Single(listed!, r => r.Kind == AgentRequests.Flow);
        Assert.Equal([Review, Merge], request.Stages);
    }

    [Fact]
    public async Task Rewrite_KeepsUnderlineInDescriptionAndStripsFenceAroundEachStage()
    {
        _agent.Lines =
        [
            Result("""
                === этап «Ревью»
                ```markdown
                # Ревью

                исполнитель: reviewer
                выход: вердикт по sha

                Порядок
                ===
                1. Собрать дифф.
                ```
                === новый этап
                ```
                # Документация

                исполнитель: оператор
                выход: раздел
                ```
                """.ReplaceLineEndings("\n")),
        ];
        var client = await Client();

        var events = await Rewrite(client, "Уточни ревью и заведи документацию", [Review], ["Ревью", "Мерж"]);

        var rewritten = Assert.Single(events);
        Assert.Equal("rewritten", rewritten.Type);
        Assert.Equal(2, rewritten.Stages!.Count);
        Assert.Equal("Ревью", rewritten.Stages[0].Of);
        Assert.Equal("Порядок\n===\n1. Собрать дифф.", rewritten.Stages[0].Stage.Description);
        Assert.Null(rewritten.Stages[1].Of);
        Assert.Equal("Документация", rewritten.Stages[1].Stage.Title);
    }

    [Fact]
    public async Task Rewrite_ReadsRenamedAndNewStagesAndHelpers()
    {
        _agent.Lines = [Result("""
            === этап «Мерж»
            # Слияние

            исполнитель: оркестратор
            помощники: check-runner
            выход: sha в dev

            === новый этап
            # Документация

            исполнитель: оператор
            выход: раздел документации
            """.ReplaceLineEndings("\n"))];
        var client = await Client();

        var events = await Rewrite(client, "Переименуй мерж и добавь документацию", [Merge], ["Ревью", "Мерж"]);

        var stages = events[^1].Stages!;
        Assert.Equal("Мерж", stages[0].Of);
        Assert.Equal("Слияние", stages[0].Stage.Title);
        Assert.Equal("merge", stages[0].Stage.Slug);
        Assert.Equal(["check-runner"], stages[0].Stage.Helpers);
        Assert.Null(stages[1].Of);
        Assert.Null(stages[1].Stage.Slug);
        Assert.Equal("Документация", stages[1].Stage.Title);
    }

    [Fact]
    public async Task Rewrite_RunsReadOnlyClaudeInMainCopyWithContextPerformersAndKitRules()
    {
        _agent.Lines = [Result(NewDocs)];
        var client = await Client();

        await Rewrite(client, "--help, напиши этап документации", [Review], ["Ревью", "Мерж"]);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        // Агент читает код проекта: работает он в основной копии, а базу видит по её пути.
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--permission-mode"));
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        // Правила формы этапа агент получает из справки кита, а не своими словами панели.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains(_base, prompt);
        Assert.Contains("Ключи — закрытый перечень: исполнитель, выход, пропуск.", prompt);
        Assert.Contains("Инвариантов кита во флоу нет.", prompt);
        Assert.DoesNotContain("Два флоу с одним именем.", prompt);
        // Этапы контекста приходят такими, какими их видно на экране, вместе с исполнителями проекта.
        Assert.Contains("--help, напиши этап документации", _agent.Input);
        Assert.Contains("Добавленный этап «Ревью»:\n# Ревью\n\nисполнитель: reviewer", _agent.Input);
        Assert.Contains("Остальные этапы проекта: «Мерж»", _agent.Input);
        Assert.Contains("- reviewer — Вычитывает дифф ветки задачи", _agent.Input);
    }

    [Fact]
    public async Task Rewrite_WithoutContext_AsksForNewStage()
    {
        _agent.Lines = [Result(NewDocs)];
        var client = await Client();

        var events = await Rewrite(client, "Напиши этап документации", [], ["Ревью"]);

        Assert.Contains("Этапов к просьбе не добавлено: напиши новый этап.", _agent.Input);
        Assert.Null(Assert.Single(events[^1].Stages!).Of);
    }

    [Fact]
    public async Task Rewrite_WithoutMainCopy_RunsInBase()
    {
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        _agent.Lines = [Result(NewDocs)];
        var client = await Client();

        await Rewrite(client, "Напиши этап документации", [], []);

        Assert.Equal(_base, _agent.StartInfo!.WorkingDirectory);
        Assert.DoesNotContain("--add-dir", _agent.StartInfo.ArgumentList);
    }

    [Fact]
    public async Task Rewrite_LeavesBaseAsItWas()
    {
        _agent.Lines = [Result(NewDocs)];
        var client = await Client();

        var events = await Rewrite(client, "Напиши этап", [], []);

        Assert.Equal("rewritten", events[^1].Type);
        Assert.False(Directory.Exists(Path.Combine(_base, "flow")));
    }

    [Theory]
    [InlineData("Готово, я поправил ревью.", "Чудо-Юдо вернул не этап: этапов в его ответе нет")]
    [InlineData("=== этап «Сборка»\n# Сборка\n\nисполнитель: оператор\nвыход: есть\n", "Чудо-Юдо вернул этап «Сборка», которого в просьбе не было")]
    [InlineData("=== Ревью\n# Ревью\n\nисполнитель: оператор\nвыход: есть\n", "Чудо-Юдо вернул этап без пометки, какой он переписал: «=== Ревью»")]
    // Кривая пометка второго этапа не вклеивается в описание первой, а названа.
    [InlineData("=== этап «Ревью»\n# Ревью\n\nисполнитель: оператор\nвыход: есть\n\nОписание.\n=== этап «Мерж» (изменена)\n# Мерж\n\nисполнитель: оператор\nвыход: есть\n", "Чудо-Юдо вернул этап без пометки, какой он переписал: «=== этап «Мерж» (изменена)»")]
    [InlineData("=== этап «Ревью»\n# Ревью\n\nисполнитель: оператор\n", "Этап «Ревью» вернулся не в форме кита: не указан выход")]
    [InlineData("=== этап «Ревью»\n# Ревью\n\nисполнитель: оператор\nвыход: есть\nвозврат: красное\n", "Этап «Ревью» вернулся не в форме кита: строка 5: ключ вне перечня «возврат: красное»")]
    [InlineData("=== новый этап\n# Мерж\n\nисполнитель: оператор\nвыход: есть\n", "Этап «Мерж» вернулся с названием, которое у проекта уже есть")]
    public async Task Rewrite_RejectsAnswerThatKitWouldNotAccept(string answer, string expected)
    {
        _agent.Lines = [Result(answer)];
        var client = await Client();

        var events = await Rewrite(client, "Поправь ревью", [Review], ["Ревью", "Мерж"]);

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal(expected, error.Text);
        Assert.Equal(answer, error.Output);
        Assert.Null(error.Stages);
    }

    [Fact]
    public async Task Rewrite_TitleFreedByRewrittenStage_CanGoToNewStage()
    {
        _agent.Lines = [Result("""
            === этап «Ревью»
            # Проверка

            исполнитель: reviewer
            выход: вердикт

            === новый этап
            # Ревью

            исполнитель: reviewer
            выход: вердикт второго круга
            """.ReplaceLineEndings("\n"))];
        var client = await Client();

        var events = await Rewrite(client, "Разбей ревью на две", [Review], ["Ревью", "Мерж"]);

        Assert.Equal("rewritten", events[^1].Type);
    }

    [Fact]
    public async Task Rewrite_WithoutKitRules_DoesNotRunAgent()
    {
        _agent.Lines = [Result(NewDocs)];

        var events = await Rewrite(await Client(withKit: false), "Напиши этап", [], []);

        var error = Assert.Single(events);
        Assert.Contains("правила формы этапа", error.Text);
        Assert.Contains(FlowRules.RulesFile, error.Text);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Rewrite_ReportsAgentThatDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = await Client();

        var events = await Rewrite(client, "Напиши этап", [], []);

        var error = Assert.Single(events);
        Assert.Equal("Claude Code не запустился", error.Text);
        Assert.Equal("Не удаётся найти указанный файл", error.Output);
    }

    [Fact]
    public async Task Rewrite_RejectsBaseOutsideListAndEmptyWish()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = await Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Напиши этап", [], []))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  ", [], []))).StatusCode);
        Assert.Null(_agent.StartInfo);
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

    private static HttpRequestMessage Post(string basePath, string wish, FlowStage[] stages, string[] titles) =>
        new(HttpMethod.Post, "/api/flow/rewrite")
        {
            Content = JsonContent.Create(new FlowRewriteRequest(basePath, wish, stages, titles)),
        };

    /// <summary>Как окно: просьба заводится POST, а ход и итог читаются её потоком с начала.</summary>
    private async Task<List<FlowRewriteEvent>> Rewrite(HttpClient client, string wish, FlowStage[] stages, string[] titles)
    {
        using var started = await client.SendAsync(Post(_base, wish, stages, titles));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var body = await client.GetStringAsync("/api/agent/flow/stream?from=0");
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonSerializer.Deserialize<FlowRewriteEvent>(line, Json)!)
            .ToList();
    }

    private async Task<HttpClient> Client(bool withKit = true)
    {
        var client = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и читает вывод.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
            });
        }).CreateClient();

        if (withKit)
            (await client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
        return client;
    }

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
