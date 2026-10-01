using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Trackers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Переписка с Чудо-Юдо об описании трекера проекта — B-293.</summary>
public sealed class TrackerRewriteTests : IDisposable
{
    private const string Layout = """
        # Раскладка базы

        ## Трекер

        `tracker.md` описывает трекер проекта.

        ```markdown
        ## Где задачи

        трекер: YouTrack
        ```

        Шаблон проекта — регулярное выражение.

        ## Когда параллельные задачи сходятся

        Сведение с remote.
        """;

    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly TrackerDescription GitHub = new(
        "GitHub", "https://github.com", "acme/orders", "Ходим gh.", "Задачи на мне.", "Метка in-progress.",
        "Ничего: задачу закрывает мерж.", "В acme/orders без меток.");

    private readonly string _root = Directory.CreateTempSubdirectory("akw-tracker-rewrite-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _copy;
    private readonly string _kit;
    private readonly TestChat _agent = new();

    public TrackerRewriteTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _copy);
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
        _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        Directory.CreateDirectory(Path.Combine(_kit, "reference"));
        File.WriteAllText(Path.Combine(_kit, TrackerRules.RulesFile), Layout.ReplaceLineEndings("\n"));
    }

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root, () =>
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
        });
    }

    [Fact]
    public void Rules_TakeTrackerSectionWithFencedHeading()
    {
        var rules = TrackerRules.Read(_kit);

        Assert.NotNull(rules);
        Assert.StartsWith("## Трекер", rules);
        Assert.Contains("трекер: YouTrack", rules);
        Assert.Contains("Шаблон проекта — регулярное выражение.", rules);
        Assert.DoesNotContain("Сведение с remote.", rules);
    }

    [Fact]
    public async Task Start_RunsReadOnlyAgentInMainCopyWithKitRulesAndEmptyDescription()
    {
        _agent.Answers = [[Result("Какой у проекта трекер?")]];
        var client = await Client();

        await Start(client, "Заведи трекер", null);
        var events = await Read(client, 2);

        Assert.Equal(new TrackerRewriteEvent("reply", "Заведи трекер"), events[0]);
        Assert.Equal("answer", events[1].Type);
        Assert.Equal("Какой у проекта трекер?", events[1].Text);
        Assert.Null(events[1].Proposal);
        var startInfo = Assert.Single(_agent.Starts);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains("«Order Service»", prompt);
        Assert.Contains("GitHub, GitLab, Jira, YouTrack", prompt);
        Assert.Contains("Шаблон проекта — регулярное выражение.", prompt);
        Assert.Equal("Просьба оператора:\nЗаведи трекер\n\nОписание в окне сейчас:\nпусто — трекер у проекта заводится.", Text(_agent.Input[0]));
    }

    [Fact]
    public async Task Answer_WithDescriptionBlock_ProposesItAndCountsChanges()
    {
        var proposed = GitHub with { Project = "acme/crm", Take = "Метка in-progress и назначить на себя." };
        _agent.Answers = [[Result("Поменял проект и взятие.\n\n=== описание\n```markdown\n" + TrackerDescriptions.Serialize(proposed, "Order Service") + "```")]];
        var client = await Client();

        await Start(client, "Проект теперь acme/crm", GitHub);
        var answer = (await Read(client, 2))[1];

        Assert.Equal("answer", answer.Type);
        Assert.Equal("Поменял проект и взятие.", answer.Text);
        Assert.Equal(proposed, answer.Proposal);
        Assert.Equal(new TrackerChanged(1, 1), answer.Changed);
        Assert.Contains("проект: acme/orders", Text(_agent.Input[0]));
    }

    /// <summary>Чудо-Юдо знает строку отбора и предлагает её в поле «Фильтр» (B-300).</summary>
    [Fact]
    public async Task Answer_WithFilterLine_ProposesFilter()
    {
        var proposed = GitHub with { Filter = "label:bug" };
        _agent.Answers = [[Result("Добавил отбор.\n=== описание\n" + TrackerDescriptions.Serialize(proposed, "Order Service"))]];
        var client = await Client();

        await Start(client, "Показывай только баги", GitHub);
        var answer = (await Read(client, 2))[1];

        Assert.Equal(proposed, answer.Proposal);
        Assert.Equal(new TrackerChanged(1, 0), answer.Changed);
        var args = Assert.Single(_agent.Starts).ArgumentList.ToList();
        Assert.Contains("«фильтр: State: {To Do}»", args[args.IndexOf("--append-system-prompt") + 1]);
    }

    /// <summary>Описание не в форме кита панель один раз возвращает агенту на доработку, как переписка о флоу.</summary>
    [Fact]
    public async Task Answer_NotKitForm_GoesBackForReworkOnce()
    {
        var broken = TrackerDescriptions.Serialize(GitHub with { Closed = "" }, "Order Service");
        var fixedText = TrackerDescriptions.Serialize(GitHub, "Order Service");
        _agent.Answers = [[Result("Вот.\n=== описание\n" + broken)], [Result("Исправил.\n=== описание\n" + fixedText)]];
        var client = await Client();

        await Start(client, "Заведи GitHub", null);
        var events = await Read(client, 3);

        Assert.Equal("rework", events[1].Type);
        Assert.Contains("раздел «Задача закрыта» — раздел не может быть пустым", events[1].Text);
        Assert.Contains("Панель не приняла твой ответ", Text(_agent.Input[1]));
        Assert.Equal("answer", events[2].Type);
        Assert.Equal(GitHub, events[2].Proposal);
    }

    [Fact]
    public async Task Answer_NotKitFormTwice_IsErrorWithAgentWords()
    {
        var broken = "Вот.\n=== описание\n" + TrackerDescriptions.Serialize(GitHub with { Project = "orders" }, "X");
        _agent.Answers = [[Result(broken)], [Result(broken)]];
        var client = await Client();

        await Start(client, "Заведи GitHub", null);
        var events = await Read(client, 3);

        Assert.Equal("error", events[2].Type);
        Assert.Contains("строка «проект:» — проект GitHub", events[2].Text);
        Assert.Equal(broken, events[2].Output);
    }

    /// <summary>Каждая реплика несёт описание, каким оно стоит в окне: поправленное руками агент видит.</summary>
    [Fact]
    public async Task Reply_CarriesDescriptionAsInWindow()
    {
        _agent.Answers = [[Result("Какой проект?")], [Result("Понял.")]];
        var client = await Client();
        await Start(client, "Заведи GitHub", null);
        await Read(client, 2);

        var reply = await client.PostAsJsonAsync(
            "/api/trackers/rewrite/reply", new TrackerRewriteReply("acme/orders", GitHub with { Where = "Руками: gh." }));
        await Read(client, 4);

        Assert.Equal(HttpStatusCode.NoContent, reply.StatusCode);
        var input = Text(_agent.Input[1]);
        Assert.StartsWith("Оператор:\nacme/orders", input);
        Assert.Contains("Руками: gh.", input);
        Assert.DoesNotContain("Твоё последнее предложение", input);
    }

    /// <summary>
    /// Непринятое предложение не теряется: окно трекера осталось прежним, а агент получает своё предложение рядом с ним
    /// и правит его; «В изменениях» сверяется с ним, а не с окном — как у исполнителя (ревью B-323).
    /// </summary>
    [Fact]
    public async Task Reply_BeforeAccept_CarriesPendingProposalAndComparesWithIt()
    {
        var proposed = GitHub with { Project = "acme/crm" };
        var filtered = proposed with { Filter = "label:bug" };
        _agent.Answers = [
            [Result("Поменял проект.\n=== описание\n" + TrackerDescriptions.Serialize(proposed, "Order Service"))],
            [Result("Добавил фильтр.\n=== описание\n" + TrackerDescriptions.Serialize(filtered, "Order Service"))],
        ];
        var client = await Client();
        await Start(client, "Проект теперь acme/crm", GitHub);
        await Read(client, 2);

        await client.PostAsJsonAsync("/api/trackers/rewrite/reply", new TrackerRewriteReply("Поставь ещё фильтр label:bug", GitHub));
        var events = await Read(client, 4);

        var input = Text(_agent.Input[1]);
        Assert.Contains("Описание в окне сейчас:", input);
        Assert.Contains("проект: acme/orders", input);
        Assert.Contains("Твоё последнее предложение", input);
        Assert.Contains("проект: acme/crm", input);
        Assert.Equal(filtered, events[3].Proposal);
        // Сверка с прошлым предложением: поменялась одна строка — фильтр, а не проект вместе с ним.
        Assert.Equal(new TrackerChanged(1, 0), events[3].Changed);
    }

    /// <summary>Кончившийся агент не теряет разговора целиком: новый получает окно и непринятое предложение (ревью B-323).</summary>
    [Fact]
    public async Task Reply_AfterAgentEnded_RaisesNewAgentWithWindowAndProposal()
    {
        _agent.StopAfterRun[0] = 1;
        var proposed = GitHub with { Project = "acme/crm" };
        _agent.Answers = [[Result("Вот.\n=== описание\n" + TrackerDescriptions.Serialize(proposed, "Order Service"))], [Result("Понял.")]];
        var client = await Client();
        await Start(client, "Проект теперь acme/crm", GitHub);
        await Read(client, 2);

        var reply = await client.PostAsJsonAsync("/api/trackers/rewrite/reply", new TrackerRewriteReply("Ещё раз", GitHub with { Where = "Руками." }));
        await Read(client, 5);

        Assert.Equal(HttpStatusCode.NoContent, reply.StatusCode);
        Assert.Equal(2, _agent.Starts.Count);
        var input = Text(_agent.Input[1]);
        Assert.StartsWith("Просьба оператора:\nЕщё раз", input);
        Assert.Contains("Руками.", input);
        Assert.Contains("Твоё последнее предложение", input);
        Assert.Contains("проект: acme/crm", input);
    }

    [Fact]
    public async Task Start_NoKitRules_IsRefusedWithReason()
    {
        File.Delete(Path.Combine(_kit, TrackerRules.RulesFile));
        var client = await Client();

        using var response = await client.PostAsJsonAsync("/api/trackers/rewrite", new TrackerRewriteRequest(_base, "Заведи", null));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Contains("правила описания трекера", (await response.Content.ReadFromJsonAsync<TrackerRewriteEvent>(Json))!.Text);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Requests_ListTrackerConversation()
    {
        _agent.Answers = [[Result("ok")]];
        var client = await Client();
        await Start(client, "Заведи трекер", null);
        await Read(client, 2);

        var requests = await client.GetFromJsonAsync<List<JsonElement>>("/api/agent/requests");

        Assert.Contains(requests!, r => r.GetProperty("kind").GetString() == AgentRequests.Tracker);
    }

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

    private async Task Start(HttpClient client, string wish, TrackerDescription? description)
    {
        using var started = await client.PostAsJsonAsync("/api/trackers/rewrite", new TrackerRewriteRequest(_base, wish, description));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
    }

    private static async Task<List<TrackerRewriteEvent>> Read(HttpClient client, int count)
    {
        using var response = await client.GetAsync("/api/agent/tracker/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var events = new List<TrackerRewriteEvent>();
        while (events.Count < count)
        {
            var line = await reader.ReadLineAsync().WaitAsync(Wait);
            Assert.NotNull(line);
            if (line.Trim().Length > 0)
                events.Add(JsonSerializer.Deserialize<TrackerRewriteEvent>(line, Json)!);
        }
        return events;
    }

    private async Task<HttpClient> Client()
    {
        var client = _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
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
        (await client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
        return client;
    }
}
