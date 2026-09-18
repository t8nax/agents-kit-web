using System.Net;
using AgentsKitWeb.Api.Usage;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class AnthropicLimitsTests : IDisposable
{
    /// <summary>Ответ живого эндпоинта, снятый оператором 18 сентября 2026 года, без лишних полей.</summary>
    private const string RealAnswer = """
        {"five_hour":{"utilization":35.0,"resets_at":"2026-09-18T15:30:00.658606+00:00","limit_dollars":null},
         "seven_day":{"utilization":27.4,"resets_at":"2026-09-24T06:00:01.658628+00:00","limit_dollars":null},
         "seven_day_opus":null,
         "limits":[{"kind":"session","group":"session","percent":35,"severity":"normal","resets_at":"2026-09-18T15:30:00.658606+00:00","is_active":true},
                   {"kind":"weekly_all","group":"weekly","percent":27,"severity":"normal","resets_at":"2026-09-24T06:00:01.658628+00:00","is_active":false}]}
        """;

    private readonly string _directory = Directory.CreateTempSubdirectory("akw-limits-").FullName;
    private readonly string _credentials;

    public AnthropicLimitsTests()
    {
        _credentials = Path.Combine(_directory, ".credentials.json");
        File.WriteAllText(_credentials, """{"claudeAiOauth":{"accessToken":"ключ-оператора"}}""");
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void Parse_ReadsBothWindowsOfTheRealAnswer()
    {
        var snapshot = AnthropicLimits.Parse(RealAnswer);

        Assert.Null(snapshot.Problem);
        Assert.Equal(35, snapshot.FiveHours!.Percent);
        Assert.Equal(
            new DateTimeOffset(2026, 9, 18, 15, 30, 0, TimeSpan.Zero),
            snapshot.FiveHours.ResetsAt!.Value.ToUniversalTime(),
            TimeSpan.FromSeconds(1));
        // Дробный процент округляется: раздел показывает целое
        Assert.Equal(27, snapshot.Week!.Percent);
    }

    [Fact]
    public void Parse_FallsBackToTheLimitsList()
    {
        // Полей верхнего уровня нет — те же числа лежат списком limits
        var snapshot = AnthropicLimits.Parse("""
            {"limits":[{"kind":"session","percent":42,"resets_at":"2026-09-18T15:30:00+00:00"},
                       {"kind":"weekly_all","percent":8,"resets_at":"2026-09-24T06:00:00+00:00"}]}
            """);

        Assert.Null(snapshot.Problem);
        Assert.Equal(42, snapshot.FiveHours!.Percent);
        Assert.Equal(8, snapshot.Week!.Percent);
    }

    [Fact]
    public void Parse_AnswerWithoutPercents_IsNamedAsChangedWay()
    {
        var snapshot = AnthropicLimits.Parse("""{"spend":{"used":{"amount_minor":0}}}""");

        Assert.NotNull(snapshot.Problem);
        Assert.Contains("способ запроса изменился", snapshot.Problem);
        Assert.Null(snapshot.FiveHours);
    }

    [Fact]
    public void Parse_NotJsonAtAll_IsNamedToo()
    {
        Assert.Contains("не разобрать", AnthropicLimits.Parse("<html>502</html>").Problem);
    }

    [Fact]
    public async Task ReadAsync_SendsTheTokenAsBearerAndReadsPercents()
    {
        string? authorization = null;
        var limits = Limits(request =>
        {
            authorization = request.Headers.Authorization?.ToString();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(RealAnswer) };
        });

        var snapshot = await limits.ReadAsync(CancellationToken.None);

        Assert.Equal("Bearer ключ-оператора", authorization);
        Assert.Equal(35, snapshot.FiveHours!.Percent);
    }

    [Fact]
    public async Task ReadAsync_WithoutCredentials_AsksToSignIn()
    {
        File.Delete(_credentials);
        var limits = Limits(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(RealAnswer) });

        var snapshot = await limits.ReadAsync(CancellationToken.None);

        Assert.Contains("не выполнен вход", snapshot.Problem);
        Assert.Null(snapshot.FiveHours);
    }

    [Fact]
    public async Task ReadAsync_RefusedToken_SaysItMayBeStale()
    {
        var limits = Limits(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized));

        var snapshot = await limits.ReadAsync(CancellationToken.None);

        Assert.Contains("протух", snapshot.Problem);
    }

    [Fact]
    public async Task ReadAsync_ServerError_NamesTheCode()
    {
        var limits = Limits(_ => new HttpResponseMessage(HttpStatusCode.BadGateway));

        Assert.Equal("Anthropic ответил 502.", (await limits.ReadAsync(CancellationToken.None)).Problem);
    }

    [Fact]
    public async Task ReadAsync_NoNetwork_SaysSoWithoutTheRequestInside()
    {
        var limits = Limits(_ => throw new HttpRequestException("GET https://api.anthropic.com/api/oauth/usage failed"));

        var snapshot = await limits.ReadAsync(CancellationToken.None);

        Assert.Equal("Связаться с Anthropic не удалось.", snapshot.Problem);
        // Ни адреса, ни заголовков запроса в строке для оператора нет
        Assert.DoesNotContain("http", snapshot.Problem, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_ProblemNeverCarriesTheToken()
    {
        foreach (var answer in new[]
                 {
                     new HttpResponseMessage(HttpStatusCode.Unauthorized),
                     new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("не json") },
                 })
        {
            var snapshot = await Limits(_ => answer).ReadAsync(CancellationToken.None);

            Assert.NotNull(snapshot.Problem);
            Assert.DoesNotContain("ключ-оператора", snapshot.Problem);
        }
    }

    private AnthropicLimits Limits(Func<HttpRequestMessage, HttpResponseMessage> answer)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection([new KeyValuePair<string, string?>("UsageLimitsUrl", "https://anthropic.test/usage")])
            .Build();
        return new AnthropicLimits(new HttpClient(new FakeHandler(answer)), new ClaudeCredentials(_credentials), configuration);
    }

    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request));
    }
}
