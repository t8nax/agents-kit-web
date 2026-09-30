using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Блок «Выкладка в Стабильный» карточки «Панель»: стоящая Бета уходит в Стабильный кнопкой — выкладкой на GitHub
/// от имени того, кем gh вошла в GitHub.
/// </summary>
public sealed class PanelStableTests : IDisposable
{
    private static readonly DateTimeOffset Built = new(2026, 9, 29, 19, 40, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-stable-").FullName;
    private readonly TestReleases _releases = new();
    private readonly TestPromotion _promotion = new();
    private readonly TestHosts _hosts = new();

    [Fact]
    public async Task Stable_StandingBetaNewerThanStable_IsReady()
    {
        _releases.Channel("master", Release("0.27.4.0"));
        var client = Client(Panel("dev", "0.28.1.3"));

        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");

        Assert.Equal(new PanelStableResponse("0.28.1.3", "0.27.4.0", "ready"), stable);
        Assert.Equal("t8nax/agents-kit-web", _promotion.AskedRights);
    }

    [Fact]
    public async Task Stable_WithoutStableReleases_IsReady()
    {
        _releases.Channel("master");
        var client = Client(Panel("dev", "0.28.0.1"));

        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");

        Assert.Equal(new PanelStableResponse("0.28.0.1", null, "ready"), stable);
    }

    [Fact]
    public async Task Stable_WithoutRightsToTheRepository_IsNoRights()
    {
        _releases.Channel("master", Release("0.27.4.0"));
        _promotion.Can = false;
        var client = Client(Panel("dev", "0.28.1.3"));

        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");

        Assert.Equal("no-rights", stable!.State);
    }

    [Theory]
    [InlineData("0.28.1.3", "already")]
    [InlineData("0.28.2.1", "older")]
    public async Task Stable_WhenStableIsNotBehind_HasNothingToPromote(string stableVersion, string state)
    {
        _releases.Channel("master", Release(stableVersion));
        var client = Client(Panel("dev", "0.28.1.3"));

        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");

        Assert.Equal(state, stable!.State);
        // Выкладывать нечего — GitHub о правах и запусках не спрашивается.
        Assert.Null(_promotion.AskedRights);
    }

    [Theory]
    [InlineData("in_progress", null, "running")]
    [InlineData("queued", null, "running")]
    [InlineData("completed", "failure", "failed")]
    [InlineData("completed", "cancelled", "failed")]
    [InlineData("completed", "success", "already")]
    public async Task Stable_FollowsTheLastPromotionRunOfTheStandingBuild(string status, string? conclusion, string state)
    {
        // Выпуски GitHub панель держит пару минут: только что вышедшую сборку раньше видно по запуску выкладки.
        _releases.Channel("master", Release("0.27.4.0"));
        _promotion.Run = new PromotionRun(status, conclusion, Built);
        var client = Client(Panel("dev", "0.28.1.3"));

        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");

        Assert.Equal(state, stable!.State);
        Assert.Equal("0.28.1.3", _promotion.AskedRun);
    }

    [Theory]
    [InlineData("master", "dev")] // стоит Стабильный, выбрана Бета: выкладывать нечего
    [InlineData("dev", "master")] // стоит Бета, выбран Стабильный
    [InlineData("feat/task", null)] // собрана из ветки задачи
    public async Task Stable_OutsideStandingBeta_IsNotFound(string built, string? chosen)
    {
        _releases.Channel("master", Release("0.27.4.0"));
        var client = Client(Panel(built, "0.28.1.3"));
        if (chosen is not null)
            (await client.PutAsJsonAsync("/api/panel/channel", new PanelChannelRequest(chosen))).EnsureSuccessStatusCode();

        var response = await client.GetAsync("/api/panel/stable");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Stable_InDevelopmentRun_IsNotFound()
    {
        var client = Client(null);

        var response = await client.GetAsync("/api/panel/stable");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Stable_WhenGitHubIsSilent_IsBadGateway()
    {
        var client = Client(Panel("dev", "0.28.1.3"));

        var response = await client.GetAsync("/api/panel/stable");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    [Fact]
    public async Task Promote_StartsTheStandingBuild_AndIsRunningUntilGitHubShowsTheRun()
    {
        _releases.Channel("master", Release("0.27.4.0"));
        // В Бете вышла сборка новее — выкладывается всё равно стоящая.
        _releases.Channel("dev", Release("0.28.1.5"), Release("0.28.1.3"));
        var client = Client(Panel("dev", "0.28.1.3"));

        var response = await client.PostAsync("/api/panel/stable", null);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(("t8nax/agents-kit-web", "0.28.1.3"), _promotion.Started);
        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");
        Assert.Equal("running", stable!.State);
    }

    [Fact]
    public async Task Promote_AfterFailure_StartsAgain()
    {
        _releases.Channel("master", Release("0.27.4.0"));
        _promotion.Run = new PromotionRun("completed", "failure", Built);
        var client = Client(Panel("dev", "0.28.1.3"));

        var response = await client.PostAsync("/api/panel/stable", null);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.NotNull(_promotion.Started);
    }

    [Theory]
    [InlineData("0.28.1.3", true, null)] // уже в Стабильном
    [InlineData("0.27.4.0", false, null)] // нет прав
    [InlineData("0.27.4.0", true, "in_progress")] // уже идёт
    public async Task Promote_WhenNotReady_IsConflictAndStartsNothing(string stableVersion, bool can, string? running)
    {
        _releases.Channel("master", Release(stableVersion));
        _promotion.Can = can;
        if (running is not null)
            _promotion.Run = new PromotionRun(running, null, Built);
        var client = Client(Panel("dev", "0.28.1.3"));

        var response = await client.PostAsync("/api/panel/stable", null);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Null(_promotion.Started);
    }

    [Fact]
    public async Task Promote_RefusedByGitHub_TellsWhy()
    {
        _releases.Channel("master", Release("0.27.4.0"));
        _promotion.Refusal = "HTTP 404: Not Found";
        var client = Client(Panel("dev", "0.28.1.3"));

        var response = await client.PostAsync("/api/panel/stable", null);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("HTTP 404: Not Found", await response.Content.ReadAsStringAsync());
        var stable = await client.GetFromJsonAsync<PanelStableResponse>("/api/panel/stable");
        Assert.Equal("ready", stable!.State);
    }

    [Fact]
    public void LastRun_IsTheNewestRunOfTheBuild()
    {
        const string json = """
            [
              {"displayTitle":"Выкладка 0.28.1.4 в Стабильный","status":"in_progress","conclusion":"","createdAt":"2026-09-29T21:00:00Z"},
              {"displayTitle":"Выкладка 0.28.1.3 в Стабильный","status":"completed","conclusion":"success","createdAt":"2026-09-29T20:30:00Z"},
              {"displayTitle":"Выкладка 0.28.1.3 в Стабильный","status":"completed","conclusion":"failure","createdAt":"2026-09-29T20:00:00Z"}
            ]
            """;

        var run = PanelPromotions.ParseLastRun(json, "0.28.1.3");

        Assert.Equal(new PromotionRun("completed", "success", new DateTimeOffset(2026, 9, 29, 20, 30, 0, TimeSpan.Zero)), run);
        Assert.Null(PanelPromotions.ParseLastRun(json, "0.28.0.1"));
    }

    private static PanelRelease Release(string version) => new(version, $"v{version}", []);

    private static PublishedPanel Panel(string channel, string version) =>
        new(channel, channel, "4189d1f", version, Built, null, @"C:\panel\app", 5080, "agents-kit-web panel");

    private HttpClient Client(PublishedPanel? panel)
    {
        var file = Path.Combine(_root, "published.json");
        if (panel is not null)
            File.WriteAllText(file, JsonSerializer.Serialize(panel, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            }));
        return _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", file),
                    new("PanelFile", Path.Combine(_root, "panel", "panel.json")),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IPanelReleases>();
                services.AddSingleton<IPanelReleases>(_releases);
                services.RemoveAll<IPanelPromotion>();
                services.AddSingleton<IPanelPromotion>(_promotion);
            });
        })).CreateClient();
    }

    public void Dispose()
    {
        _hosts.Dispose();
        Directory.Delete(_root, recursive: true);
    }

    private sealed class TestPromotion : IPanelPromotion
    {
        public bool Can { get; set; } = true;

        public PromotionRun? Run { get; set; }

        public string? Refusal { get; set; }

        public string? AskedRights { get; private set; }

        public string? AskedRun { get; private set; }

        public (string Repository, string Version)? Started { get; private set; }

        public Task<bool> CanPromoteAsync(string repository, CancellationToken cancellationToken)
        {
            AskedRights = repository;
            return Task.FromResult(Can);
        }

        public Task<PromotionRun?> LastRunAsync(string repository, string version, CancellationToken cancellationToken)
        {
            AskedRun = version;
            return Task.FromResult(Run);
        }

        public Task<string?> StartAsync(string repository, string version)
        {
            if (Refusal is null)
                Started = (repository, version);
            return Task.FromResult(Refusal);
        }
    }
}
