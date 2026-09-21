using System.Net.Http.Json;
using AgentsKitWeb.Api.Usage;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class UsageEndpointsTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 9, 18, 16, 30, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-usage-api-").FullName;
    private readonly string _projects;
    private LimitsSnapshot _limits = new(new WindowLimit(46, Now.AddHours(2)), new WindowLimit(62, Now.AddDays(3)), null);

    public UsageEndpointsTests()
    {
        _projects = Path.Combine(_root, "projects");
        Directory.CreateDirectory(_projects);
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

    private void Journal(string name, params (DateTimeOffset At, string Model, long Output)[] answers)
    {
        var path = Path.Combine(_projects, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllLines(path, answers.Select(answer =>
            "{\"type\":\"assistant\",\"timestamp\":\"" + answer.At.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") +
            "\",\"message\":{\"model\":\"" + answer.Model + "\",\"usage\":{\"output_tokens\":" + answer.Output + "}}}"));
    }

    [Fact]
    public async Task Usage_CountsWindowsFromJournalsAndTakesPercentsFromLimits()
    {
        Journal("D--Projects-nota/one.jsonl",
            (Now.AddHours(-1), "claude-opus-5", 100),
            (Now.AddDays(-2), "claude-sonnet-5", 40));

        var view = await Client().GetFromJsonAsync<UsageView>("/api/usage");

        Assert.NotNull(view);
        Assert.Equal(100, view.FiveHours.Tokens);
        Assert.Equal(140, view.Week.Tokens);
        Assert.Equal(46, view.FiveHours.Percent);
        Assert.Equal(62, view.Week.Percent);
        Assert.Equal(Now.AddHours(2), view.FiveHours.ResetsAt);
        Assert.Null(view.LimitsProblem);
        Assert.Equal(2, view.Models.Count);
    }

    [Fact]
    public async Task Usage_EstimatesDayPercentFromShareOfWeek()
    {
        Journal("D--Projects-nota/one.jsonl",
            (Now.AddHours(-1), "claude-opus-5", 100),
            (Now.AddDays(-2), "claude-sonnet-5", 500));

        var view = await Client().GetFromJsonAsync<UsageView>("/api/usage");

        Assert.NotNull(view);
        Assert.Equal(100, view.Day.Tokens);
        // Opus весит впятеро: сутки — 500 из 1000 взвешенных, половина недели
        Assert.Equal(0.5, view.Day.Share, 5);
        // Процента за сутки Anthropic не даёт — оценка из доли и процента недели
        Assert.Equal(31, view.Day.Percent!.Value, 5);
    }

    [Fact]
    public async Task Usage_LimitsFailed_KeepsTokensAndNamesTheProblem()
    {
        Journal("D--Projects-nota/one.jsonl", (Now.AddHours(-1), "claude-opus-5", 100));
        _limits = LimitsSnapshot.Failed("Anthropic не ответил.");

        var view = await Client().GetFromJsonAsync<UsageView>("/api/usage");

        Assert.NotNull(view);
        Assert.Equal("Anthropic не ответил.", view.LimitsProblem);
        Assert.Null(view.FiveHours.Percent);
        Assert.Null(view.Week.Percent);
        // Свой счёт по журналам отказ Anthropic не отменяет
        Assert.Equal(100, view.FiveHours.Tokens);
        Assert.Equal(100, view.Week.Tokens);
        // Без процента недели оценки за сутки нет, а токены и доля остаются
        Assert.Null(view.Day.Percent);
        Assert.Equal(100, view.Day.Tokens);
        Assert.Equal(1, view.Day.Share, 5);
    }

    [Fact]
    public async Task Usage_NoJournalsAtAll_GivesZeroesAndNoModels()
    {
        var view = await Client().GetFromJsonAsync<UsageView>("/api/usage");

        Assert.NotNull(view);
        Assert.Equal(0, view.Week.Tokens);
        Assert.Empty(view.Models);
    }

    [Fact]
    public async Task Usage_AccessTokenNeverReachesTheAnswer()
    {
        // Ключ в ответе панели не появляется ни при каком отказе: строка отказа пишется панелью.
        Journal("D--Projects-nota/one.jsonl", (Now.AddHours(-1), "claude-opus-5", 100));
        _limits = LimitsSnapshot.Failed("Anthropic не ответил: 401.");

        var body = await Client().GetStringAsync("/api/usage");

        Assert.DoesNotContain("accessToken", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Bearer", body, StringComparison.OrdinalIgnoreCase);
    }

    private HttpClient Client() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", Path.Combine(_root, "bases.json")),
                    new("ProjectsDir", _projects),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(new FixedTime(Now));
                services.RemoveAll<UsageScanner>();
                services.AddSingleton(new UsageScanner(_projects, new FixedTime(Now)));
                services.RemoveAll<ILimits>();
                services.AddSingleton<ILimits>(new FakeLimits(() => _limits));
            });
        }).CreateClient();

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class FakeLimits(Func<LimitsSnapshot> snapshot) : ILimits
    {
        public Task<LimitsSnapshot> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(snapshot());
    }
}
