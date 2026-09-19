using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PanelEndpointsTests : IDisposable
{
    private static readonly DateTimeOffset Built = new(2026, 9, 12, 19, 40, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-panel-").FullName;

    [Fact]
    public async Task Panel_WithoutPublishedFile_IsDevelopmentRun()
    {
        using var factory = Factory(Published());

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
        var file = Published(Panel("dev", "origin/dev", "4189d1f", "1.0.0", _root));
        using var factory = Factory(file);

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
        var file = Published(Panel("feat/some-task", "feat/some-task", "abc1234", "1.0.0", _root));
        using var factory = Factory(file);

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
        using var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.False(panel.Installed);
    }

    [Fact]
    public async Task Channel_Chosen_OutlivesPanelRestart()
    {
        var file = Published(Panel("master", "origin/master", "4189d1f", "1.0.0", _root));
        using (var factory = Factory(file))
        {
            var response = await factory.CreateClient().PutAsJsonAsync("/api/panel/channel", new PanelChannelRequest("dev"));
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        }

        using var restarted = Factory(file);
        var panel = await restarted.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.Equal("dev", panel?.Channel);
    }

    [Fact]
    public async Task Channel_Unknown_IsRefused()
    {
        using var factory = Factory(Published());

        var response = await factory.CreateClient().PutAsJsonAsync("/api/panel/channel", new PanelChannelRequest("master-2"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Updates_ListTheTasksThatArrivedSincePanelWasBuilt()
    {
        var (repository, standing) = RepositoryWithReleases();
        var file = Published(Panel("dev", "origin/dev", standing, "1.0.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal(Head(Path.Combine(_root, "origin")), update.Sha);
        Assert.Equal(
            ["Исполнитель синхронизируется по копиям", "Переход строки ведёт в сессию задачи"],
            update.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_WhenPanelIsCurrent_ListNothing()
    {
        var (repository, _) = RepositoryWithReleases();
        var head = Head(repository);
        var file = Published(Panel("dev", "origin/dev", head, "1.2.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal(head, update.Sha);
        Assert.Empty(update.Releases);
    }

    [Fact]
    public async Task Updates_ListTheTaskWhoseVersionWasNotRaised()
    {
        // Работа уехала в канал, а номер версии за ней не подняли: по номерам панель выглядела бы
        // свежей, и отставание видно только по коду.
        var (repository, _) = RepositoryWithReleases();
        var origin = Path.Combine(_root, "origin");
        var standing = Head(origin);
        Change(origin, "Оператор удаляет рабочую копию из панели");
        var file = Published(Panel("dev", "origin/dev", standing, "1.2.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal(Head(origin), update.Sha);
        Assert.Equal(["Оператор удаляет рабочую копию из панели"], update.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_OnDevelopmentRun_AreNotAnswered()
    {
        using var factory = Factory(Published());

        var response = await factory.CreateClient().GetAsync("/api/panel/updates");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// <summary>Репозиторий с origin, где вышли 1.1.0 и 1.2.0; возвращает путь копии и sha версии 1.0.0.</summary>
    private (string Repository, string Standing) RepositoryWithReleases()
    {
        var origin = TestGit.Repository(Path.Combine(_root, "origin"));
        Release(origin, "1.0.0", "Первая панель");
        var standing = Head(origin);
        Release(origin, "1.1.0", "Переход строки ведёт в сессию задачи");
        Release(origin, "1.2.0", "Исполнитель синхронизируется по копиям");

        var copy = Path.Combine(_root, "copy");
        TestGit.Run(_root, "clone", origin, copy);
        return (copy, standing);
    }

    /// <summary>Коммит, который номер версии не поднял: в перечень вышедшего он не попадает.</summary>
    private static void Change(string repository, string title)
    {
        File.WriteAllText(Path.Combine(repository, "changed.txt"), title + "\n");
        TestGit.Run(repository, "add", "changed.txt");
        TestGit.Run(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", title);
    }

    [Fact]
    public async Task Updates_DropTheMergePrefixFromWhatArrived()
    {
        var (repository, standing) = RepositoryWithReleases();
        Change(Path.Combine(_root, "origin"), "Merge fix/some-task: копия удаляется из панели");
        var file = Published(Panel("dev", "origin/dev", standing, "1.0.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.Equal("копия удаляется из панели", update?.Releases[0].Title);
    }

    private static void Release(string repository, string version, string title)
    {
        File.WriteAllText(Path.Combine(repository, "version.txt"), version + "\n");
        TestGit.Run(repository, "add", "version.txt");
        TestGit.Run(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", title);
    }

    private static string Head(string repository)
    {
        var head = Path.Combine(repository, ".git", "refs", "heads", "dev");
        return File.ReadAllText(head).Trim();
    }

    /// <summary>Что оставил бы скрипт публикации: каталог, порт и задача для этих тестов не важны.</summary>
    private static PublishedPanel Panel(string channel, string reference, string sha, string version, string repository) =>
        new(channel, reference, sha, version, Built, repository, @"C:\panel\app", 5080, "agents-kit-web panel");

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
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", publishedFile),
                    new("PanelFile", Path.Combine(_root, "panel", "panel.json")),
                ]);
            }));

    public void Dispose()
    {
        // Файлы объектов git лежат только для чтения, и обычное удаление каталога о них спотыкается.
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_root, recursive: true);
    }
}
