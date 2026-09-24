using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class PanelEndpointsTests : IDisposable
{
    private static readonly DateTimeOffset Built = new(2026, 9, 12, 19, 40, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-panel-").FullName;
    private readonly TestReleases _releases = new();
    private readonly TestHosts _hosts = new();

    [Fact]
    public async Task Panel_WithoutPublishedFile_IsDevelopmentRun()
    {
        var factory = Factory(Published());

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.False(panel.Installed);
        Assert.Null(panel.Published);
        // Номер приходит из version.txt репозитория, зашитого в сборку.
        Assert.Matches(@"^\d+\.\d+\.\d+$", panel.Version);
        Assert.Equal(PanelChannelStore.Master, panel.Channel);
    }

    [Fact]
    public async Task Panel_WithPublishedFile_TellsChannelAndBuild()
    {
        var file = Published(Panel("dev", "origin/dev", "4189d1f", "1.0.0"));
        var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.True(panel.Installed);
        Assert.Equal("dev", panel.Channel);
        Assert.NotNull(panel.Published);
        Assert.Equal("4189d1f", panel.Published.Sha);
        Assert.Equal("1.0.0", panel.Published.Version);
        Assert.Equal(Built, panel.Published.BuiltAt);
    }

    [Fact]
    public async Task Panel_BuiltFromTaskBranch_FallsBackToMasterChannel()
    {
        var file = Published(Panel("feat/some-task", "feat/some-task", "abc1234", "1.0.0"));
        var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.Equal("feat/some-task", panel.Published?.Channel);
        Assert.Equal(PanelChannelStore.Master, panel.Channel);
    }

    [Fact]
    public async Task Panel_WithBrokenPublishedFile_FallsBackToDevelopmentRun()
    {
        var file = Path.Combine(_root, "published.json");
        File.WriteAllText(file, "не json");
        var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.False(panel.Installed);
    }

    [Fact]
    public async Task Channel_Chosen_OutlivesPanelRestart()
    {
        var file = Published(Panel("master", "origin/master", "4189d1f", "1.0.0"));
        var factory = Factory(file);
        var response = await factory.CreateClient().PutAsJsonAsync("/api/panel/channel", new PanelChannelRequest("dev"));
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        TestHost.Stop(factory);

        var restarted = Factory(file);
        var panel = await restarted.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.Equal("dev", panel?.Channel);
    }

    [Fact]
    public async Task Channel_Unknown_IsRefused()
    {
        var factory = Factory(Published());

        var response = await factory.CreateClient().PutAsJsonAsync("/api/panel/channel", new PanelChannelRequest("master-2"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Panel_ReadsBuildLeftBeforeReleases()
    {
        // Сборка из исходников до выпусков на GitHub оставила путь к репозиторию, а не имя выпусков.
        var file = Path.Combine(_root, "published.json");
        File.WriteAllText(file, """
            {"channel":"master","ref":"origin/master","sha":"4189d1f","version":"9.8.1",
             "builtAt":"2026-09-12T19:40:00Z","repository":"D:\\Projects\\agents-kit-web",
             "target":"C:\\panel\\app","port":5080,"taskName":"agents-kit-web panel"}
            """);
        var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.True(panel?.Installed);
        Assert.Equal("9.8.1", panel?.Published?.Version);
    }

    [Fact]
    public async Task Updates_ListTheReleasesNewerThanThePanel()
    {
        _releases.Channel("dev",
            Release("0.10.2", "исполнитель синхронизируется по копиям"),
            Release("0.10.1", "переход строки ведёт в сессию задачи", "копия удаляется из панели"),
            Release("0.10.0", "первая панель"));
        var file = Published(Panel("dev", "origin/dev", "4189d1f", "0.10.0"));
        var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal("0.10.2", update.Latest);
        // Новые первыми, у каждого — свои задачи.
        Assert.Equal(["0.10.2", "0.10.1"], update.Releases.Select(release => release.Version));
        Assert.Equal(["переход строки ведёт в сессию задачи", "копия удаляется из панели"], update.Releases[1].Tasks);
        Assert.Equal((PanelUpdates.DefaultRepository, "dev"), _releases.Asked);
    }

    [Fact]
    public async Task Updates_WhenPanelIsCurrent_ListNothing()
    {
        _releases.Channel("master", Release("0.10.1"), Release("0.10.0"));
        var file = Published(Panel("master", "origin/master", "4189d1f", "0.10.1"));
        var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.Equal("0.10.1", update?.Latest);
        Assert.Empty(update!.Releases);
    }

    [Fact]
    public async Task Updates_AskTheReleasesTheBuildNamed()
    {
        _releases.Channel("master", Release("0.10.0"));
        var file = Published(Panel("master", "origin/master", "4189d1f", "0.10.0") with { Releases = "someone/fork" });
        var factory = Factory(file);

        await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.Equal(("someone/fork", "master"), _releases.Asked);
    }

    [Fact]
    public async Task Updates_WhenGitHubIsSilent_AreBadGateway()
    {
        var file = Published(Panel("master", "origin/master", "4189d1f", "0.10.0"));
        var factory = Factory(file);

        var response = await factory.CreateClient().GetAsync("/api/panel/updates");

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    [Fact]
    public async Task Updates_OnDevelopmentRun_AreNotAnswered()
    {
        var factory = Factory(Published());

        var response = await factory.CreateClient().GetAsync("/api/panel/updates");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public void Releases_OfTheChannel_AreReadFromGitHubAnswer()
    {
        // Выпуски master — обычные v<номер>, выпуски dev — предварительные v<номер>-dev;
        // задачи — строки «- …» описания, черновики не в счёт.
        const string answer = """
            [
              {"tag_name":"v0.10.1-dev","draft":false,"prerelease":true,"body":"- вторая задача\r\n- первая задача"},
              {"tag_name":"v0.10.1","draft":false,"prerelease":false,"body":"- вторая задача"},
              {"tag_name":"v0.10.2-dev","draft":true,"prerelease":true,"body":"- черновик"},
              {"tag_name":"v0.9.10-dev","draft":false,"prerelease":true,"body":""},
              {"tag_name":"v0.10.0-dev","draft":false,"prerelease":true,"body":null}
            ]
            """;

        var dev = GitHubReleases.Parse(answer, "dev");
        var master = GitHubReleases.Parse(answer, "master");

        Assert.Equal(["0.10.1", "0.10.0", "0.9.10"], dev.Select(release => release.Version));
        Assert.Equal(["вторая задача", "первая задача"], dev[0].Tasks);
        Assert.Equal("v0.10.1-dev", dev[0].Tag);
        Assert.Equal(["v0.10.1"], master.Select(release => release.Tag));
    }

    private static PanelRelease Release(string version, params string[] tasks) => new(version, $"v{version}", tasks);

    /// <summary>Что оставила бы постановка: каталог, порт и задача для этих тестов не важны.</summary>
    private static PublishedPanel Panel(string channel, string reference, string sha, string version) =>
        new(channel, reference, sha, version, Built, null, @"C:\panel\app", 5080, "agents-kit-web panel");

    private string Published(PublishedPanel? panel = null)
    {
        var file = Path.Combine(_root, "published.json");
        if (panel is not null)
            File.WriteAllText(file, JsonSerializer.Serialize(panel, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            }));
        return file;
    }

    private WebApplicationFactory<Program> Factory(string publishedFile) =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", publishedFile),
                    new("PanelFile", Path.Combine(_root, "panel", "panel.json")),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IPanelReleases>();
                services.AddSingleton<IPanelReleases>(_releases);
            });
        }));

    public void Dispose()
    {
        _hosts.Dispose();
        Directory.Delete(_root, recursive: true);
    }
}
