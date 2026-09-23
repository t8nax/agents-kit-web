using System.Net;
using AgentsKitWeb.Api.Panel;

namespace AgentsKitWeb.Api.Tests;

public sealed class GitHubReleasesTests
{
    private const string Answer = """[{"tag_name":"v0.10.1","draft":false,"body":"- задача"}]""";

    [Fact]
    public async Task Releases_AreAskedOnceInAFewMinutes()
    {
        // Без ключа GitHub отвечает шестьдесят раз в час: открытие «Настроек» не должно тратить их зря.
        var github = new Answers(() => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Answer) });
        var time = new Clock();
        var releases = new GitHubReleases(github, time);

        await releases.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None);
        var cached = await releases.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None);
        time.Now += TimeSpan.FromMinutes(3);
        await releases.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None);

        Assert.Equal("v0.10.1", cached?.Single().Tag);
        Assert.Equal(2, github.Asked);
        Assert.Equal("https://api.github.com/repos/t8nax/agents-kit-web/releases?per_page=100&page=1", github.Last?.ToString());
    }

    [Fact]
    public async Task Releases_OfBothChannels_ShareOneAnswer()
    {
        // GitHub отдаёт оба канала одним списком: переключение канала не тратит второй запрос.
        const string both = """[{"tag_name":"v0.10.1-dev","body":""},{"tag_name":"v0.10.0","body":""}]""";
        var github = new Answers(() => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(both) });
        var releases = new GitHubReleases(github, new Clock());

        var master = await releases.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None);
        var dev = await releases.ReadAsync("t8nax/agents-kit-web", "dev", CancellationToken.None);

        Assert.Equal("v0.10.0", master?.Single().Tag);
        Assert.Equal("v0.10.1-dev", dev?.Single().Tag);
        Assert.Equal(1, github.Asked);
    }

    [Fact]
    public async Task Releases_BeyondTheFirstPage_AreFound()
    {
        // Выпуск dev выходит на каждое слияние: выпуск master может оказаться дальше первой сотни.
        var dev = string.Join(",", Enumerable.Range(0, 100).Select(n => $$"""{"tag_name":"v0.10.{{n}}-dev","body":""}"""));
        var pages = new Queue<string>([$"[{dev}]", """[{"tag_name":"v0.9.0","body":""}]"""]);
        var github = new Answers(() => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(pages.Dequeue()) });
        var releases = new GitHubReleases(github, new Clock());

        var master = await releases.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None);

        Assert.Equal("v0.9.0", master?.Single().Tag);
        Assert.Equal("https://api.github.com/repos/t8nax/agents-kit-web/releases?per_page=100&page=2", github.Last?.ToString());
    }

    [Fact]
    public async Task Releases_WhenGitHubFails_AreNull()
    {
        var failing = new GitHubReleases(new Answers(() => new HttpResponseMessage(HttpStatusCode.Forbidden)), new Clock());
        var silent = new GitHubReleases(new Answers(() => throw new HttpRequestException("нет сети")), new Clock());

        Assert.Null(await failing.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None));
        Assert.Null(await silent.ReadAsync("t8nax/agents-kit-web", "master", CancellationToken.None));
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 9, 23, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Answers(Func<HttpResponseMessage> answer) : HttpMessageHandler, IHttpClientFactory
    {
        public int Asked { get; private set; }

        public Uri? Last { get; private set; }

        public HttpClient CreateClient(string name) =>
            new(this, disposeHandler: false) { BaseAddress = new Uri("https://api.github.com/") };

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Asked++;
            Last = request.RequestUri;
            return Task.FromResult(answer());
        }
    }
}
