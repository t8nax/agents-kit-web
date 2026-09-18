using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Просьба живёт в панели, а не в окне: оборванный поток агента не трогает, ход копится дальше, а итог ждёт
/// оператора. Останавливает агента только DELETE — то самое «Отменить» окна.
/// </summary>
public sealed class AgentRequestsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-agent-").FullName;
    private readonly string _base;
    private readonly FakeAgent _agent = new();

    public AgentRequestsTests()
    {
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(_base);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт");
    }

    [Fact]
    public async Task Request_KeepsAgentWorkingAfterStreamIsDropped()
    {
        var release = new TaskCompletionSource();
        _agent.Lines =
        [
            Tool("Read", new { file_path = Path.Combine(_base, "product.md") }),
            Result("Так решил оператор."),
        ];
        _agent.BeforeLine = index => index == 1 ? release.Task : Task.CompletedTask;
        var client = Client();
        await Ask(client, "Что за проект?");

        // Оператор закрыл окно на первом шаге: поток оборван, а агент работает дальше.
        using (var cancel = new CancellationTokenSource())
        {
            using var dropped = await client.GetAsync(
                "/api/agent/ask/stream?from=0", HttpCompletionOption.ResponseHeadersRead, cancel.Token);
            using var reader = new StreamReader(await dropped.Content.ReadAsStreamAsync(cancel.Token));
            Assert.Equal("step", Event(await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10))).Type);
            await cancel.CancelAsync();
        }
        release.SetResult();

        // Оператор вернулся: ход виден весь, вместе с ответом, пришедшим без него.
        var events = await Stream(client);
        Assert.Equal("step", events[0].Type);
        Assert.Equal("answer", events[1].Type);
        Assert.Equal("Так решил оператор.", events[1].Text);
        Assert.Equal(2, events.Count);
        Assert.False(_agent.Cancelled);
    }

    [Fact]
    public async Task Requests_ShowRunningRequestAndThenItsFinishedOutcome()
    {
        var release = new TaskCompletionSource();
        _agent.Lines = [Result("ответ")];
        _agent.BeforeLine = _ => release.Task;
        var client = Client();
        await Ask(client, "Что за проект?");

        var running = Assert.Single(await Requests(client));
        Assert.Equal("ask", running.Kind);
        Assert.Equal("running", running.State);
        Assert.Equal("Что за проект?", running.Text);
        Assert.Equal("Order Service", running.Project);

        release.SetResult();
        await Stream(client);

        var finished = Assert.Single(await Requests(client));
        Assert.Equal("done", finished.State);
        Assert.Equal(running.Id, finished.Id);
    }

    [Fact]
    public async Task Delete_StopsAgentAndForgetsRequest()
    {
        var client = Client();
        _agent.BeforeLine = _ => Task.Delay(Timeout.Infinite);
        _agent.Lines = [Result("ответ")];
        await Ask(client, "Что за проект?");

        var deleted = await client.DeleteAsync("/api/agent/ask");

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Empty(await Requests(client));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/agent/ask/stream")).StatusCode);
        Assert.True(await _agent.CancelledWithin(TimeSpan.FromSeconds(10)));
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/agent/ask")).StatusCode);
    }

    [Fact]
    public async Task Ask_StartedAgain_ReplacesRequestAndStopsTheFormerAgent()
    {
        var client = Client();
        _agent.BeforeLine = _ => Task.Delay(Timeout.Infinite);
        _agent.Lines = [Result("ответ")];
        var first = await Ask(client, "Первый вопрос");

        var second = await Ask(client, "Второй вопрос");

        var only = Assert.Single(await Requests(client));
        Assert.Equal(second.Id, only.Id);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal("Второй вопрос", only.Text);
        Assert.True(await _agent.CancelledWithin(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Stream_OfAnotherRequest_IsNotFound()
    {
        var client = Client();
        _agent.Lines = [Result("ответ")];
        await Ask(client, "Что за проект?");

        var other = await client.GetAsync("/api/agent/ask/stream?id=00000000000000000000000000000000");

        Assert.Equal(HttpStatusCode.NotFound, other.StatusCode);
    }

    [Fact]
    public async Task Requests_OfKindsNobodyAsked_AreEmpty()
    {
        Assert.Empty(await Requests(Client()));
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
        result = text,
    });

    private static AskEvent Event(string? line) => JsonSerializer.Deserialize<AskEvent>(line!, Json)!;

    private async Task<AgentRequestSummary> Ask(HttpClient client, string question)
    {
        var response = await client.PostAsJsonAsync("/api/ask", new AskRequest(_base, question));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<AgentRequestSummary>(Json))!;
    }

    private static async Task<List<AgentRequestSummary>> Requests(HttpClient client) =>
        (await client.GetFromJsonAsync<List<AgentRequestSummary>>("/api/agent/requests", Json))!;

    private static async Task<List<AskEvent>> Stream(HttpClient client, int from = 0)
    {
        var body = await client.GetStringAsync($"/api/agent/ask/stream?from={from}");
        return body.Split(Environment.NewLine.ToCharArray(), StringSplitOptions.RemoveEmptyEntries)
            .Select(Event!)
            .ToList();
    }

    private HttpClient Client() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, кто и когда его останавливает.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
            });
        }).CreateClient();

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

    private sealed class FakeAgent : IAgentProcess
    {
        private readonly TaskCompletionSource _cancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public IReadOnlyList<string> Lines { get; set; } = [];
        public Func<int, Task> BeforeLine { get; set; } = _ => Task.CompletedTask;
        public bool Cancelled => _cancelled.Task.IsCompleted;

        public async Task<bool> CancelledWithin(TimeSpan timeout)
        {
            try
            {
                await _cancelled.Task.WaitAsync(timeout);
                return true;
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            try
            {
                for (var i = 0; i < Lines.Count; i++)
                {
                    await BeforeLine(i).WaitAsync(cancellationToken);
                    await onLine(Lines[i]);
                }
            }
            catch (OperationCanceledException)
            {
                _cancelled.TrySetResult();
                throw;
            }
            return new AgentExit(0, "");
        }
    }
}
