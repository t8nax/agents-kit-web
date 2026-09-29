using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Трекер проекта из панели — карточка «Трекеры проектов», B-293.</summary>
public sealed class ProjectTrackersEndpointsTests : IDisposable
{
    private const string Url = "/api/trackers/projects";

    // Заглушка sync.ps1 кита: пишет, с чем её позвали, и отвечает словами и кодом из sync-<действие>.txt.
    private const string Sync = """
        param([string]$Path, [string]$Repo, [string]$Action)
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'sync.log') -Value "$Action|$Repo|$Path" -Encoding utf8
        $answer = Join-Path $PSScriptRoot "sync-$Action.txt"
        if (Test-Path -LiteralPath $answer) {
            $lines = @(Get-Content -LiteralPath $answer -Encoding utf8)
            Write-Host $lines[1]
            exit ([int]$lines[0])
        }
        Write-Host "на remote базы отдано коммитов: 1"
        exit 0
        """;

    private static readonly TrackerDescription GitHub = new(
        "GitHub", "https://github.com", "acme/orders", "Ходим gh.", "Задачи на мне.", "Метка in-progress.",
        "Ничего: задачу закрывает мерж.", "В acme/orders без меток.");

    private readonly string _root = Directory.CreateTempSubdirectory("akw-project-trackers-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly FakeGitHubIssues _github = new();
    private readonly FakeYouTrack _youTrack = new();
    private readonly string _main;
    private readonly string _base;
    private string _kit = "";

    public ProjectTrackersEndpointsTests()
    {
        _main = TestGit.Repository(Path.Combine(_root, "app"));
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _main);
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
        TestGit.Run(_base, "init", "-q", "-b", "main");
        TestGit.Run(_base, "config", "user.name", "t");
        TestGit.Run(_base, "config", "user.email", "t@t");
        TestGit.Run(_base, "config", "core.autocrlf", "false");
        TestGit.Run(_base, "add", "--", ".gitignore", BaseLayout.MarkerFile, "product.md");
        TestGit.Run(_base, "commit", "-q", "-m", "init");
    }

    public void Dispose()
    {
        _hosts.Dispose();
        // Объекты git лежат только для чтения: без снятия атрибута каталог прогона не удалить.
        TestDirs.Delete(_root, () =>
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
        });
    }

    private string TrackerFile => Path.Combine(_base, "tracker.md");

    private string SyncLog => Path.Combine(_kit, "scripts", "sync.log");

    private async Task<HttpClient> Client(bool kit = true)
    {
        var client = _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base)), new("HealthIntervalSeconds", "3600")]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IGitHubIssues>();
                services.AddSingleton<IGitHubIssues>(_github);
                services.RemoveAll<IYouTrack>();
                services.AddSingleton<IYouTrack>(_youTrack);
            });
        })).CreateClient();
        if (kit)
        {
            _kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
            File.WriteAllText(Path.Combine(_kit, "scripts", "sync.ps1"), Sync);
            (await client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
        }
        return client;
    }

    private void Answer(string action, int code, string words) =>
        File.WriteAllText(Path.Combine(_kit, "scripts", $"sync-{action}.txt"), $"{code}\n{words}\n");

    private void Committed(string text)
    {
        File.WriteAllText(TrackerFile, text);
        TestGit.Run(_base, "add", "--", "tracker.md");
        TestGit.Run(_base, "commit", "-q", "-m", "трекер");
    }

    private void Memory(string file, string title) =>
        File.WriteAllText(Path.Combine(TestLayout.Work(_base), file), $"# {title}\nрабочая копия: {_main}\n");

    private string Git(params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = _base,
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

    private async Task<ProjectTrackerRow> Row(HttpClient client) =>
        Assert.Single((await client.GetFromJsonAsync<List<ProjectTrackerRow>>(Url))!);

    private static Task<HttpResponseMessage> Save(HttpClient client, string @base, string? version, TrackerDescription description) =>
        client.PutAsJsonAsync(Url, new SaveProjectTrackerRequest(@base, version, description));

    [Fact]
    public async Task List_NoTracker_RowWithoutDescription()
    {
        var row = await Row(await Client(kit: false));

        Assert.Equal(_base, row.Base);
        Assert.Equal("Order Service", row.Project);
        Assert.Null(row.Problem);
        Assert.Null(row.Tracker);
        Assert.Null(row.Description);
        Assert.Equal("", row.Version);
        Assert.Empty(row.Busy);
        Assert.False(row.NewerFormat);
    }

    [Fact]
    public async Task List_Described_CarriesTrackerDescriptionAndTasksOfTracker()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        Memory("a.md", "GitHub #37 Починить выгрузку");
        Memory("b.md", "B-5 Запись бэклога");

        var row = await Row(await Client(kit: false));

        Assert.Equal(new TrackerInfo(TrackerInfo.GitHub, "GitHub", "https://github.com", "acme/orders"), row.Tracker);
        Assert.Equal(GitHub, row.Description);
        Assert.Equal(ProjectTrackersEndpoints.Version(TrackerFile), row.Version);
        Assert.Equal([new TrackerTask("GitHub #37 Починить выгрузку", _main)], row.Busy);
    }

    /// <summary>Задачу Jira кит называет «Jira PAY-7»: она держит описание так же, как задача GitHub.</summary>
    [Fact]
    public async Task List_JiraTask_IsBusy()
    {
        Committed(TrackerDescriptions.Serialize(GitHub with { Tracker = "Jira", Server = "https://acme.atlassian.net", Project = "PAY" }, "X"));
        Memory("a.md", "jira PAY-7 Выгрузка");

        Assert.Equal("jira PAY-7 Выгрузка", Assert.Single((await Row(await Client(kit: false))).Busy).Task);
    }

    [Fact]
    public async Task Save_New_ChecksWritesCommitsAndSyncsLikeKit()
    {
        var client = await Client();

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var saved = (await response.Content.ReadFromJsonAsync<ProjectTrackerSaved>())!;
        Assert.True(saved.Checked);
        Assert.True(saved.Pushed);
        Assert.Null(saved.Message);
        Assert.Equal(ProjectTrackersEndpoints.Version(TrackerFile), saved.Version);
        Assert.Equal(TrackerDescriptions.Serialize(GitHub, "Order Service"), File.ReadAllText(TrackerFile));
        Assert.Equal(ProjectTrackersEndpoints.CommitMessage, Git("log", "-1", "--format=%s"));
        Assert.Equal("tracker.md", Git("show", "--name-only", "--format=", "HEAD"));
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Equal(["acme/orders"], _github.Asked);
        // Как кит: забрать базу до записи, отдать — после.
        Assert.Equal([$"Pull|Base|{_main}", $"Push|Base|{_main}"], File.ReadAllLines(SyncLog));
    }

    [Fact]
    public async Task Save_Existing_OverVersionTheOperatorSaw()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        var client = await Client();
        var row = await Row(client);

        var response = await Save(client, _base, row.Version, GitHub with { Project = "acme/crm" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("acme/crm", TrackerDescriptions.Parse(File.ReadAllText(TrackerFile)).Project);
        Assert.Equal("2", Git("rev-list", "--count", "HEAD", "--", "tracker.md"));
    }

    /// <summary>Переводы строк, BOM и заголовок прежнего файла остаются: в истории базы видна только правка (ревью B-293).</summary>
    [Fact]
    public async Task Save_KeepsLineEndingsBomAndHeaderOfFile()
    {
        var text = TrackerDescriptions.Serialize(GitHub, "x", "# Заказы — наш трекер").Replace("\n", "\r\n");
        File.WriteAllBytes(TrackerFile, [0xEF, 0xBB, 0xBF, .. System.Text.Encoding.UTF8.GetBytes(text)]);
        TestGit.Run(_base, "add", "--", "tracker.md");
        TestGit.Run(_base, "commit", "-q", "-m", "трекер");
        var client = await Client();

        var response = await Save(client, _base, ProjectTrackersEndpoints.Version(TrackerFile), GitHub with { Project = "acme/crm" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var bytes = File.ReadAllBytes(TrackerFile);
        Assert.Equal([0xEF, 0xBB, 0xBF], bytes[..3]);
        var written = System.Text.Encoding.UTF8.GetString(bytes[3..]);
        Assert.Equal(text.Replace("проект: acme/orders", "проект: acme/crm"), written);
        Assert.Equal("1\t1\ttracker.md", Git("diff", "--numstat", "HEAD~1", "HEAD"));
    }

    /// <summary>То же описание — коммитить нечего: оно записано, а не «Git не записал» (ревью B-293).</summary>
    [Fact]
    public async Task Save_Unchanged_IsSavedWithoutCommit()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        var client = await Client();

        var response = await Save(client, _base, ProjectTrackersEndpoints.Version(TrackerFile), GitHub);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await response.Content.ReadFromJsonAsync<ProjectTrackerSaved>())!.Pushed);
        Assert.Equal("трекер", Git("log", "-1", "--format=%s"));
        Assert.Equal([$"Pull|Base|{_main}", $"Push|Base|{_main}"], File.ReadAllLines(SyncLog));
    }

    /// <summary>Проверка трекера идёт секундами: правку сессии, записанную за это время, панель не переписывает.</summary>
    [Fact]
    public async Task Save_DescriptionChangedDuringCheck_IsRefused()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        var client = await Client();
        var version = ProjectTrackersEndpoints.Version(TrackerFile);
        _github.BeforeAssigned = () =>
        {
            File.AppendAllText(TrackerFile, "Правка сессии.\n");
            TestGit.Run(_base, "commit", "-q", "-m", "сессия", "--", "tracker.md");
        };

        var response = await Save(client, _base, version, GitHub with { Project = "acme/crm" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("changed", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
        Assert.EndsWith("Правка сессии.\n", File.ReadAllText(TrackerFile));
        Assert.Equal("сессия", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_NotKitForm_NamesFieldsAndTouchesNothing()
    {
        var client = await Client();

        var response = await Save(client, _base, "", GitHub with { Project = "orders", Closed = " " });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!;
        Assert.Equal("invalid", rejected.Problem);
        Assert.Equal(["project", "closed"], rejected.Faults!.Keys);
        Assert.False(File.Exists(TrackerFile));
        Assert.False(File.Exists(SyncLog));
    }

    [Fact]
    public async Task Save_TrackerNotRead_NamesFieldAndDoesNotWrite()
    {
        _github.Answer = new TrackerIssues([], TrackerIssues.RepoUnreachable, "Could not resolve to a Repository");
        var client = await Client();

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal(
            new ProjectTrackerRejected("check", "Could not resolve to a Repository", Field: "project", Code: TrackerIssues.RepoUnreachable),
            await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>());
        Assert.False(File.Exists(TrackerFile));
        Assert.Equal([$"Pull|Base|{_main}"], File.ReadAllLines(SyncLog));
    }

    /// <summary>Jira панель не читает — описание пишется без проверки, и окно говорит об этом.</summary>
    [Fact]
    public async Task Save_Jira_WrittenUnchecked()
    {
        var client = await Client();

        var response = await Save(client, _base, "", GitHub with { Tracker = "Jira", Server = "https://acme.atlassian.net", Project = "PAY" });

        Assert.False((await response.Content.ReadFromJsonAsync<ProjectTrackerSaved>())!.Checked);
        Assert.Contains("трекер: Jira", File.ReadAllText(TrackerFile));
        Assert.Empty(_github.Asked);
    }

    [Fact]
    public async Task Save_ChangedSinceSeen_IsRefused()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        var client = await Client();

        var response = await Save(client, _base, "", GitHub with { Project = "acme/crm" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("changed", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
        Assert.Equal("acme/orders", TrackerDescriptions.Parse(File.ReadAllText(TrackerFile)).Project);
    }

    [Fact]
    public async Task Save_PullRefused_ShowsKitWordsAndDoesNotWrite()
    {
        var client = await Client();
        Answer(KitSync.Pull, 1, "с remote базы не забрано — в базе незакоммиченная правка: product.md");

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal(
            new ProjectTrackerRejected("pull", "с remote базы не забрано — в базе незакоммиченная правка: product.md"),
            await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>());
        Assert.False(File.Exists(TrackerFile));
    }

    /// <summary>Сервер базы недоступен — кит работает с базой этой машины, и панель тоже пишет.</summary>
    [Fact]
    public async Task Save_RemoteUnreachable_WritesAndSaysNotPushed()
    {
        var client = await Client();
        Answer(KitSync.Pull, 2, "remote базы недоступен: нет сети — работа идёт с локальным, отдастся при следующем сведении");
        Answer(KitSync.Push, 2, "remote базы недоступен: нет сети — работа идёт с локальным, отдастся при следующем сведении");

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var saved = (await response.Content.ReadFromJsonAsync<ProjectTrackerSaved>())!;
        Assert.False(saved.Pushed);
        Assert.Equal("remote базы недоступен: нет сети — работа идёт с локальным, отдастся при следующем сведении", saved.Message);
        Assert.Equal(ProjectTrackersEndpoints.CommitMessage, Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_UncommittedEditOfTracker_IsRefused()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        File.AppendAllText(TrackerFile, "правка сессии\n");
        var client = await Client();

        var response = await Save(client, _base, ProjectTrackersEndpoints.Version(TrackerFile), GitHub);

        Assert.Equal("dirty", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
        Assert.EndsWith("правка сессии\n", File.ReadAllText(TrackerFile));
    }

    [Fact]
    public async Task Save_NewerFormat_IsClosed()
    {
        TestLayout.NewerFormat(_base);
        var client = await Client();

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("newer-format", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
        Assert.True((await Row(client)).NewerFormat);
    }

    [Fact]
    public async Task Save_KitNotSet_IsRefused()
    {
        var client = await Client(kit: false);

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal("kit-not-set", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
        Assert.False(File.Exists(TrackerFile));
    }

    [Fact]
    public async Task Save_NoCopyOnDisk_IsRefused()
    {
        TestLayout.Machine(_base, TestLayout.Operator, @"Z:\nowhere");
        var client = await Client();

        var response = await Save(client, _base, "", GitHub);

        Assert.Equal("no-copy", (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!.Problem);
    }

    [Fact]
    public async Task Save_BaseNotInList_IsNotFound()
    {
        var client = await Client();
        var other = TestLayout.Base(Path.Combine(_root, "other-knowledge"), _main);

        Assert.Equal(HttpStatusCode.NotFound, (await Save(client, other, "", GitHub)).StatusCode);
    }

    [Fact]
    public async Task Delete_RemovesCommitsAndPushes()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        var client = await Client();
        var row = await Row(client);

        var response = await client.DeleteAsync($"{Url}?base={Uri.EscapeDataString(_base)}&version={row.Version}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await response.Content.ReadFromJsonAsync<ProjectTrackerSaved>())!.Pushed);
        Assert.False(File.Exists(TrackerFile));
        Assert.Equal(ProjectTrackersEndpoints.DeleteMessage, Git("log", "-1", "--format=%s"));
        Assert.Equal("", Git("ls-files", "--", "tracker.md"));
        Assert.Equal([$"Pull|Base|{_main}", $"Push|Base|{_main}"], File.ReadAllLines(SyncLog));
    }

    /// <summary>Пока идёт задача из трекера, описание не удаляется: сессии нечем было бы её закрыть.</summary>
    [Fact]
    public async Task Delete_TaskOfTrackerInWork_IsRefusedWithCopies()
    {
        Committed(TrackerDescriptions.Serialize(GitHub, "Order Service"));
        Memory("a.md", "GitHub #37 Починить выгрузку");
        var client = await Client();
        var row = await Row(client);

        var response = await client.DeleteAsync($"{Url}?base={Uri.EscapeDataString(_base)}&version={row.Version}");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<ProjectTrackerRejected>())!;
        Assert.Equal("busy", rejected.Problem);
        Assert.Equal([new TrackerTask("GitHub #37 Починить выгрузку", _main)], rejected.Busy);
        Assert.True(File.Exists(TrackerFile));
        Assert.False(File.Exists(SyncLog));
    }

    [Theory]
    [InlineData("на remote базы отдано коммитов: 1\nAKW_EXIT=0", 0, "на remote базы отдано коммитов: 1")]
    [InlineData("на remote базы не отдано — git: rejected\r\nAKW_EXIT=1\r\n", 1, "на remote базы не отдано — git: rejected")]
    [InlineData("что-то", -1, "что-то")]
    public void KitSync_Parse_ReadsCodeFromLastLine(string output, int code, string message) =>
        Assert.Equal(new KitSyncResult(code, message), KitSync.Parse(output));
}
