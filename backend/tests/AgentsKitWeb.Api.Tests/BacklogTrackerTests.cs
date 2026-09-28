using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class BacklogTrackerTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const string Backlog = """
        # Order Service — бэклог

        следующий номер: B-3
        поля: тип, приоритет

        ## B-1 Старая запись
        тип: фича
        приоритет: средний

        Текст старой записи.

        Вторым абзацем.

        ### Артефакты
        - снимок: artifacts/B-1-снимок.png
        - макет: https://claude.ai/artifact/AbC

        ### Агенту
        - где: App.tsx

        ## B-2 Вторая запись

        Текст второй записи.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-backlog-tracker-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly FakeGitHubIssues _github = new();
    private readonly string _base;
    private readonly string _personal;

    private string BacklogPath => Path.Combine(_personal, "backlog.md");

    public BacklogTrackerTests()
    {
        var copy = Path.Combine(_root, "app");
        Directory.CreateDirectory(copy);
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), copy);
        _personal = TestLayout.Personal(_base);
        File.WriteAllText(Path.Combine(_base, "tracker.md"), "# Order Service — трекер\n\n## Где задачи\nGitHub Issues https://github.com/acme/orders, программой gh.\n");
        TestGit.Run(_personal, "config", "user.name", "t");
        TestGit.Run(_personal, "config", "user.email", "t@t");
        TestGit.Run(_personal, "config", "core.autocrlf", "false");
        File.WriteAllText(BacklogPath, Backlog.ReplaceLineEndings("\n") + "\n");
        Directory.CreateDirectory(Path.Combine(_personal, "artifacts"));
        File.WriteAllBytes(Path.Combine(_personal, "artifacts", "B-1-снимок.png"), [1, 2, 3]);
        TestGit.Run(_personal, "add", ".");
        TestGit.Run(_personal, "commit", "-m", "base");
    }

    /// <summary>Описание — по раскладке кита: текст оператору и «Агенту»; поля и файлы в задачу не уходят, ссылки — уходят.</summary>
    [Fact]
    public void Draft_TakesTitleWithoutNumberTextAgentAndLinks()
    {
        var block = Workspaces.Backlog.Blocks(Backlog.ReplaceLineEndings("\n"))[0];

        var draft = BacklogTracker.Draft("B-1", block.Text);

        Assert.Equal("Старая запись", draft.Title);
        Assert.Equal(
            "Текст старой записи.\n\nВторым абзацем.\n\n### Артефакты\n- макет: https://claude.ai/artifact/AbC\n\n### Агенту\n- где: App.tsx",
            draft.Body);
        Assert.Equal([new TaskArtifact("снимок", "artifacts/B-1-снимок.png")], draft.Files);
    }

    [Fact]
    public void Draft_OnlyFiles_DropsArtifactsSection()
    {
        var draft = BacklogTracker.Draft("B-5", "## B-5 Запись\n\nТекст.\n\n### Артефакты\n- снимок: artifacts/B-5.png");

        Assert.Equal("Текст.", draft.Body);
        Assert.Single(draft.Files);
    }

    [Fact]
    public async Task DraftEndpoint_ReturnsWhatWillGoToTracker()
    {
        var draft = await GetDraft(Client(), "b-2");

        Assert.Equal("B-2", draft.Number);
        Assert.Equal("Вторая запись", draft.Title);
        Assert.Equal("Текст второй записи.", draft.Body);
        Assert.Empty(draft.Files);
        Assert.Equal("## B-2 Вторая запись\n\nТекст второй записи.", draft.Original);
    }

    [Theory]
    [InlineData("# Трекер\n\n## Где задачи\nJira, проект PAY.\n")]
    [InlineData("# Трекер\n\n## Где задачи\nGitHub Issues, адрес потом.\n")]
    public async Task DraftEndpoint_TrackerNotGitHubWithAddress_IsConflict(string tracker)
    {
        File.WriteAllText(Path.Combine(_base, "tracker.md"), tracker);

        using var response = await Client().GetAsync(DraftUrl("B-2"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task DraftEndpoint_UnknownEntry_IsNotFound()
    {
        using var response = await Client().GetAsync(DraftUrl("B-9"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Move_CreatesAssignedIssueAndCutsEntryWithItsFiles()
    {
        var client = Client();
        var draft = await GetDraft(client, "B-1");

        var moved = await Move(client, draft);

        var created = Assert.Single(_github.Creates);
        Assert.Equal(("acme/orders", "Старая запись", draft.Body), created);
        Assert.Equal(new TrackerIssue("GitHub #58", 58, "Старая запись", "https://github.com/acme/orders/issues/58"), moved.Issue);
        Assert.Null(moved.Error);
        Assert.Null(moved.Problem);
        Assert.NotNull(moved.Commit);
        Assert.Equal(
            "# Order Service — бэклог\n\nследующий номер: B-3\nполя: тип, приоритет\n\n## B-2 Вторая запись\n\nТекст второй записи.\n",
            File.ReadAllText(BacklogPath));
        Assert.False(File.Exists(Path.Combine(_personal, "artifacts", "B-1-снимок.png")));
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Equal("Изменить бэклог из панели", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Move_GitHubRefuses_LeavesBacklogAsWas()
    {
        _github.Created = new CreatedIssue(null, TrackerIssues.GhLogin);
        var client = Client();
        var draft = await GetDraft(client, "B-2");
        var file = File.ReadAllText(BacklogPath);

        var moved = await Move(client, draft);

        Assert.Null(moved.Issue);
        Assert.Equal(TrackerIssues.GhLogin, moved.Problem);
        Assert.Equal(file, File.ReadAllText(BacklogPath));
        Assert.Equal("base", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Move_UncommittedBacklogEdit_DoesNotGoToGitHub()
    {
        var client = Client();
        var draft = await GetDraft(client, "B-2");
        File.AppendAllText(BacklogPath, "\n## Дописано руками\n");

        var moved = await Move(client, draft);

        Assert.Empty(_github.Creates);
        Assert.Null(moved.Issue);
        Assert.Equal("В backlog.md личного репозитория есть незакоммиченная правка — ничего не записано", moved.Error);
    }

    [Fact]
    public async Task Move_EntryChangedAfterWindowOpened_DoesNotGoToGitHub()
    {
        var client = Client();
        var draft = await GetDraft(client, "B-2");
        File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("Текст второй записи.", "Поправлено соседней сессией."));
        TestGit.Run(_personal, "commit", "-m", "сосед", "--", "backlog.md");

        var moved = await Move(client, draft);

        Assert.Empty(_github.Creates);
        Assert.Equal("Запись B-2 изменилась после открытия окна переноса — ничего не записано", moved.Error);
    }

    [Fact]
    public async Task Move_CommitRefusedAfterIssueCreated_NamesIssueAndLeftEntry()
    {
        var client = Client();
        var draft = await GetDraft(client, "B-2");
        var file = File.ReadAllText(BacklogPath);
        File.WriteAllText(Path.Combine(_personal, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho сверка не прошла\nexit 1\n");

        var moved = await Move(client, draft);

        Assert.Equal(58, moved.Issue?.Number);
        Assert.Equal("Коммит не прошёл — backlog.md оставлен как был", moved.Error);
        Assert.Equal(file, File.ReadAllText(BacklogPath));
    }

    public void Dispose()
    {
        _hosts.Dispose();
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private string DraftUrl(string number) =>
        $"/api/backlog/tracker/draft?base={Uri.EscapeDataString(_base)}&number={Uri.EscapeDataString(number)}";

    private async Task<TrackerDraft> GetDraft(HttpClient client, string number)
    {
        using var response = await client.GetAsync(DraftUrl(number));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TrackerDraft>(Json))!;
    }

    private async Task<TrackerMoved> Move(HttpClient client, TrackerDraft draft)
    {
        using var response = await client.PostAsJsonAsync("/api/backlog/tracker/move", new TrackerMoveRequest(_base, draft.Number, draft.Original));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TrackerMoved>(Json))!;
    }

    private string Git(params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = _personal,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = TestProcess.Start(startInfo);
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return output;
    }

    private HttpClient Client() =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IGitHubIssues>();
                services.AddSingleton<IGitHubIssues>(_github);
            });
        })).CreateClient();
}
