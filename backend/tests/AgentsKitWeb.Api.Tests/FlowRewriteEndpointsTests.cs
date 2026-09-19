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
    private const string Flow = """
        # App — флоу

        ## 1. Критерий

        исполнитель: оркестратор
        выход: критерий закрытия в памяти

        1.1. Написать критерий до первой строчки кода.

        ## 2. Мерж

        исполнитель: оркестратор
        выход: sha в dev

        """;

    private const string Rewritten = """
        # App — флоу

        ## 1. Критерий

        исполнитель: оркестратор
        выход: критерий закрытия в памяти

        1.1. Написать критерий до первой строчки кода.

        ## 2. Ревью

        исполнитель: reviewer
        выход: вердикт по sha, записанный оркестратором
        пропуск: правка только в текстах

        ## 3. Мерж

        исполнитель: оркестратор
        выход: sha в dev

        """;

    private const string Layout = """
        # Раскладка базы знаний

        ## Куда именно

        Файлы знания правятся по месту.

        ## Флоу проекта

        Шаги идут в порядке исполнения, номера подряд с 1.

        ### Шаг

        Ключи — закрытый перечень: исполнитель, выход, пропуск.

        ## Решения

        Один файл — одна область.
        """;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-rewrite-").FullName;
    private readonly string _base;
    private readonly string _flowPath;
    private readonly string _kit;
    private readonly FakeAgent _agent = new();

    public FlowRewriteEndpointsTests()
    {
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(_base);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        _flowPath = Path.Combine(_base, "flow.md");
        File.WriteAllText(_flowPath, Flow.ReplaceLineEndings("\n"));

        _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        var layout = Path.Combine(_kit, FlowRules.LayoutFile);
        Directory.CreateDirectory(Path.GetDirectoryName(layout)!);
        File.WriteAllText(layout, Layout.ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Rewrite_StreamsStepsAndRewrittenFlowWithFileVersion()
    {
        _agent.Lines =
        [
            Tool("Read", new { file_path = Path.Combine(_base, "flow.md") }),
            Result($"```markdown\n{Rewritten}```"),
        ];
        var client = await Client();

        var events = await Rewrite(client, _base, "Добавь ревью перед мержем");

        Assert.Equal(new FlowRewriteEvent("step", "читает flow.md"), events[0]);
        var rewritten = events[1];
        Assert.Equal("rewritten", rewritten.Type);
        Assert.Equal(
            ["Критерий", "Ревью", "Мерж"],
            rewritten.Steps!.Select(s => s.Title));
        Assert.Equal("reviewer", rewritten.Steps![1].Executor);
        Assert.Equal("правка только в текстах", rewritten.Steps![1].Skip);
        Assert.Equal(9200, rewritten.DurationMs);
        Assert.Equal(await Version(), rewritten.Version);
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task Rewrite_ReadsReturnsAndHelpersFromAnswer()
    {
        var answer = """
            # App — флоу

            ## 1. Критерий

            исполнитель: оркестратор
            помощники: scout, check-runner
            выход: критерий закрытия в памяти

            ## 2. Мерж

            исполнитель: оркестратор
            выход: sha в dev
            возврат: проверки красные — шаг «Критерий»

            """;
        _agent.Lines = [Result(answer.ReplaceLineEndings("\n"))];
        var client = await Client();

        var events = await Rewrite(client, _base, "Опиши круг работы в «Мерже»");

        var steps = events[^1].Steps!;
        Assert.Equal(["scout", "check-runner"], steps[0].Helpers);
        Assert.Equal([new FlowReturn("проверки красные", "Критерий")], steps[1].Returns);
    }

    [Fact]
    public async Task Rewrite_RunsReadOnlyClaudeInBaseWithFlowAndKitRulesOnStdin()
    {
        _agent.Lines = [Result(Rewritten)];
        var client = await Client();

        await Rewrite(client, _base, "--help, добавь ревью");

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_base, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.DoesNotContain(args, a => a.Contains("--permission-mode"));
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        // Правила формы флоу агент получает из раскладки кита, а не своими словами панели.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains("Ключи — закрытый перечень: исполнитель, выход, пропуск.", prompt);
        Assert.DoesNotContain("Один файл — одна область.", prompt);
        // Агент переписывает тот текст, который подала панель: он приходит в stdin вместе с просьбой.
        Assert.Contains("--help, добавь ревью", _agent.Input);
        Assert.Contains("## 2. Мерж", _agent.Input);
    }

    [Fact]
    public async Task Rewrite_LeavesFlowFileAsItWas()
    {
        _agent.Lines = [Result(Rewritten)];
        var before = await File.ReadAllBytesAsync(_flowPath);
        var client = await Client();

        var events = await Rewrite(client, _base, "Добавь ревью");

        Assert.Equal("rewritten", events[^1].Type);
        Assert.Equal(before, await File.ReadAllBytesAsync(_flowPath));
    }

    [Fact]
    public async Task Rewrite_ReportsAnswerThatIsNotFlow()
    {
        _agent.Lines = [Result("Готово, я добавил шаг ревью.")];
        var client = await Client();

        var events = await Rewrite(client, _base, "Добавь ревью");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("Чудо-Юдо вернул не флоу: шагов в его ответе нет", error.Text);
        Assert.Equal("Готово, я добавил шаг ревью.", error.Output);
    }

    [Fact]
    public async Task Rewrite_ReportsStepReturnedNotInKitForm()
    {
        _agent.Lines = [Result("# App — флоу\n\n## 1. Критерий\n\nисполнитель: оркестратор\n\n1.1. Написать.\n")];
        var client = await Client();

        var events = await Rewrite(client, _base, "Поправь критерий");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal(1, error.Step);
        Assert.Contains("не указан выход", error.Text);
    }

    [Fact]
    public async Task Rewrite_ReportsFlowChangedWhileAgentWorked()
    {
        _agent.Lines = [Result(Rewritten)];
        // Соседняя сессия правит флоу, пока агент переписывает тот текст, что подала панель.
        _agent.BeforeLine = async index =>
        {
            if (index == 0)
                await File.WriteAllTextAsync(_flowPath, Flow.ReplaceLineEndings("\n") + "\n## 3. Чужой шаг\n\nисполнитель: оператор\nвыход: есть\n");
        };
        var client = await Client();

        var events = await Rewrite(client, _base, "Добавь ревью");

        var error = Assert.Single(events);
        Assert.Equal("error", error.Type);
        Assert.Equal("changed", error.Problem);
        Assert.Null(error.Steps);
    }

    [Fact]
    public async Task Rewrite_WithoutKitRules_DoesNotRunAgent()
    {
        _agent.Lines = [Result(Rewritten)];

        var events = await Rewrite(await Client(withKit: false), _base, "Добавь ревью");

        var error = Assert.Single(events);
        Assert.Contains("правила формы флоу", error.Text);
        Assert.Contains(FlowRules.LayoutFile, error.Text);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Rewrite_ReportsAgentThatDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = await Client();

        var events = await Rewrite(client, _base, "Добавь ревью");

        var error = Assert.Single(events);
        Assert.Equal("Claude Code не запустился", error.Text);
        Assert.Equal("Не удаётся найти указанный файл", error.Output);
    }

    [Fact]
    public async Task Rewrite_RejectsBaseOutsideListAndEmptyWish()
    {
        var other = Directory.CreateDirectory(Path.Combine(_root, "other")).FullName;
        var client = await Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Добавь ревью"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public void Rules_ReadsFlowSectionOfKitLayoutOnly()
    {
        var rules = FlowRules.Read(_kit);

        Assert.StartsWith("## Флоу проекта", rules);
        Assert.Contains("### Шаг", rules);
        Assert.DoesNotContain("Один файл — одна область.", rules);
        Assert.Null(FlowRules.Read(null));
        Assert.Null(FlowRules.Read(_root));
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
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private async Task<string> Version() => FlowFile.Fingerprint(await File.ReadAllBytesAsync(_flowPath));

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

    private static HttpRequestMessage Post(string basePath, string wish) =>
        new(HttpMethod.Post, "/api/flow/rewrite") { Content = JsonContent.Create(new FlowRewriteRequest(basePath, wish)) };

    /// <summary>Как окно: просьба заводится POST, а ход и итог читаются её потоком с начала.</summary>
    private static async Task<List<FlowRewriteEvent>> Rewrite(HttpClient client, string basePath, string wish)
    {
        using var started = await client.SendAsync(Post(basePath, wish));
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
        public Func<int, Task> BeforeLine { get; set; } = _ => Task.CompletedTask;
        public ProcessStartInfo? StartInfo { get; private set; }
        public string Input { get; private set; } = "";

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
