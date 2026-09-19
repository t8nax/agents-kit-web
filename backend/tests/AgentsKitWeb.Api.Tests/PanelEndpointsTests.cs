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
        var (repository, standing) = RepositoryWithTasks();
        var file = Published(Panel("dev", "origin/dev", standing, "1.0.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal(Head(Path.Combine(_root, "origin")), update.Sha);
        // Новые первыми, и приставка слияния из заголовка убрана — оператору она не говорит ничего.
        Assert.Equal(
            ["исполнитель синхронизируется по копиям", "переход строки ведёт в сессию задачи"],
            update.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_WhenPanelIsCurrent_ListNothing()
    {
        var (repository, _) = RepositoryWithTasks();
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
        // Задача уехала в канал, а номер версии за ней не подняли: по номерам панель выглядела бы
        // свежей, и отставание видно только по коду.
        var (repository, _) = RepositoryWithTasks();
        var origin = Path.Combine(_root, "origin");
        var standing = Head(origin);
        Task(origin, "feat/delete-workspace", "копия удаляется из панели", version: null);
        var file = Published(Panel("dev", "origin/dev", standing, "1.2.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.NotNull(update);
        Assert.Equal(Head(origin), update.Sha);
        Assert.Equal(["копия удаляется из панели"], update.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_NameTheTasksInsideABatchMerge()
    {
        // В master работа приезжает пачкой «Merge dev into master», а задачи лежат внутри пачки:
        // в перечне должны стоять задачи, а не пачка.
        var origin = TestGit.Repository(Path.Combine(_root, "origin"));
        TestGit.Run(origin, "switch", "-c", "master");
        var standing = Head(origin, "master");
        TestGit.Run(origin, "switch", "dev");
        Task(origin, "feat/delete-workspace", "копия удаляется из панели", version: null);
        TestGit.Run(origin, "switch", "master");
        TestGit.Run(
            origin, "-c", "user.name=t", "-c", "user.email=t@t",
            "merge", "--no-ff", "dev", "-m", "Merge dev into master");
        var copy = Path.Combine(_root, "copy");
        TestGit.Run(_root, "clone", origin, copy);
        var file = Published(Panel("master", "origin/master", standing, "1.2.0", copy));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.Equal(["копия удаляется из панели"], update?.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_SkipTheMergeATaskMadeIntoItself()
    {
        // Задача перед мержем подтянула канал к себе: это слияние в перечень попадать не должно —
        // оно ничего в канал не привезло.
        var (repository, _) = RepositoryWithTasks();
        var origin = Path.Combine(_root, "origin");
        var standing = Head(origin);
        TestGit.Run(origin, "switch", "-c", "feat/agent-chat");
        Commit(origin, "разговор продолжается", "chat.txt");
        TestGit.Run(origin, "switch", "dev");
        Task(origin, "feat/sidebar", "раздел открывается списком", version: null);
        TestGit.Run(origin, "switch", "feat/agent-chat");
        TestGit.Run(
            origin, "-c", "user.name=t", "-c", "user.email=t@t",
            "merge", "--no-ff", "dev", "-m", "Merge dev в feat/agent-chat перед мержем задачи");
        TestGit.Run(origin, "switch", "dev");
        TestGit.Run(
            origin, "-c", "user.name=t", "-c", "user.email=t@t",
            "merge", "--no-ff", "feat/agent-chat", "-m", "Merge feat/agent-chat: разговор продолжается");
        var file = Published(Panel("dev", "origin/dev", standing, "1.2.0", repository));
        using var factory = Factory(file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdate>("/api/panel/updates");

        Assert.Equal(
            ["разговор продолжается", "раздел открывается списком"],
            update?.Releases.Select(release => release.Title));
    }

    [Fact]
    public async Task Updates_OnDevelopmentRun_AreNotAnswered()
    {
        using var factory = Factory(Published());

        var response = await factory.CreateClient().GetAsync("/api/panel/updates");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// <summary>Репозиторий с origin, в который двумя задачами приехала работа; отдаёт копию и sha до них.</summary>
    private (string Repository, string Standing) RepositoryWithTasks()
    {
        var origin = TestGit.Repository(Path.Combine(_root, "origin"));
        File.WriteAllText(Path.Combine(origin, "version.txt"), "1.0.0\n");
        TestGit.Run(origin, "add", "version.txt");
        Commit(origin, "первая панель");
        var standing = Head(origin);
        Task(origin, "feat/session-link", "переход строки ведёт в сессию задачи", "1.1.0");
        Task(origin, "feat/performer-sync", "исполнитель синхронизируется по копиям", "1.2.0");

        var copy = Path.Combine(_root, "copy");
        TestGit.Run(_root, "clone", origin, copy);
        return (copy, standing);
    }

    /// <summary>
    /// Задача: своя ветка, правка и слияние в канал заголовком для оператора — так работа и приезжает
    /// в dev. version null — номер версии за задачей не подняли.
    /// </summary>
    private static void Task(string repository, string branch, string title, string? version)
    {
        TestGit.Run(repository, "switch", "-c", branch);
        if (version is not null)
        {
            File.WriteAllText(Path.Combine(repository, "version.txt"), version + "\n");
            TestGit.Run(repository, "add", "version.txt");
        }
        Commit(repository, title, branch.Replace('/', '-') + ".txt");
        TestGit.Run(repository, "switch", "dev");
        TestGit.Run(
            repository, "-c", "user.name=t", "-c", "user.email=t@t",
            "merge", "--no-ff", branch, "-m", $"Merge {branch}: {title}");
    }

    private static void Commit(string repository, string title, string? file = null)
    {
        if (file is not null)
        {
            File.WriteAllText(Path.Combine(repository, file), title + "\n");
            TestGit.Run(repository, "add", file);
        }
        TestGit.Run(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", title);
    }

    private static string Head(string repository, string branch = "dev")
    {
        var head = Path.Combine(repository, ".git", "refs", "heads", branch);
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
