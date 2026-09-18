using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Performers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Синхронизация исполнителя по копиям проекта: панель кладёт файл основной копии в остальные и
/// коммитит его там, а копию, куда коммитить не стоит, называет оператору до записи — B-77.
/// </summary>
public sealed class PerformerSyncEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-tests-").FullName;

    private const string Reviewer = "---\nname: reviewer\ndescription: Читает дифф.\n---\n\nТело основной копии.\n";

    [Fact]
    public async Task Sync_WritesPerformerIntoCopiesWhereItIsMissing()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        Performer(main, "reviewer", Reviewer);
        var basePath = CreateBase(main, second);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var outcome = Assert.Single((await response.Content.ReadFromJsonAsync<PerformerSyncResponse>())!.Copies);
        Assert.Equal(second, outcome.Copy);
        Assert.True(outcome.Done);
        Assert.NotNull(outcome.Commit);
        Assert.Null(outcome.Error);

        Assert.Equal(Reviewer, File.ReadAllText(Path.Combine(second, ".claude", "agents", "reviewer.md")).ReplaceLineEndings("\n"));
        Assert.Equal("Исполнитель синхронизирован из панели", Subject(second));
        Assert.Equal([".claude/agents/reviewer.md"], CommittedFiles(second));
        Assert.Empty(Status(second));
    }

    [Fact]
    public async Task Sync_OverwritesCopyWhereTheFileDiffers()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        Performer(main, "reviewer", Reviewer);
        Performer(second, "reviewer", "---\nname: reviewer\n---\n\nТело поправили руками.\n");
        var basePath = CreateBase(main, second);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Reviewer, File.ReadAllText(Path.Combine(second, ".claude", "agents", "reviewer.md")).ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Sync_DoesNothingWhenEveryCopyAlreadyHasTheSameFile()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        Performer(main, "reviewer", Reviewer);
        Performer(second, "reviewer", Reviewer);
        var basePath = CreateBase(main, second);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty((await response.Content.ReadFromJsonAsync<PerformerSyncResponse>())!.Copies);
        Assert.Equal("init", Subject(second));
    }

    [Fact]
    public async Task Sync_AsksBeforeCommittingIntoCopyOnMaster()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        TestGit.Run(second, "branch", "-m", "master");
        Performer(main, "reviewer", Reviewer);
        var basePath = CreateBase(main, second);

        var refused = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var body = await refused.Content.ReadFromJsonAsync<PerformerSyncRefusedResponse>();
        Assert.Equal("needs-confirmation", body!.Problem);
        var risky = Assert.Single(body.Risky);
        Assert.Equal(second, risky.Copy);
        Assert.Equal("master", risky.Branch);
        Assert.Equal("branch", risky.Reason);
        // Пока оператор не ответил, в копию не записано ничего.
        Assert.False(Directory.Exists(Path.Combine(second, ".claude")));

        var confirmed = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer", Confirmed: true));

        Assert.Equal(HttpStatusCode.OK, confirmed.StatusCode);
        Assert.True(File.Exists(Path.Combine(second, ".claude", "agents", "reviewer.md")));
    }

    [Fact]
    public async Task Sync_AsksBeforeCommittingIntoCopyWithUncommittedWork()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        File.WriteAllText(Path.Combine(second, "readme.md"), "чужая незакоммиченная правка\n");
        Performer(main, "reviewer", Reviewer);
        var basePath = CreateBase(main, second);

        var refused = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var body = await refused.Content.ReadFromJsonAsync<PerformerSyncRefusedResponse>();
        Assert.Equal("dirty", Assert.Single(body!.Risky).Reason);
    }

    [Fact]
    public async Task Sync_CountsOnlyOtherFilesAsUncommittedWork()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        Performer(main, "reviewer", Reviewer);
        // В копии лежит незакоммиченный файл того же исполнителя: его расхождение синхронизация и чинит.
        Performer(second, "reviewer", "---\nname: reviewer\n---\n\nДругое тело.\n");
        var basePath = CreateBase(main, second);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(Assert.Single((await response.Content.ReadFromJsonAsync<PerformerSyncResponse>())!.Copies).Done);
    }

    [Fact]
    public async Task Sync_ReportsGitOutputOfTheCopyWhereCommitWasRefused()
    {
        var main = Repository("app");
        var good = Repository("app-two");
        var refusing = Repository("app-three");
        var hooks = Path.Combine(refusing, ".git", "hooks");
        Directory.CreateDirectory(hooks);
        File.WriteAllText(Path.Combine(hooks, "pre-commit"), "#!/bin/sh\necho 'сверка не прошла'\nexit 1\n".ReplaceLineEndings("\n"));
        Performer(main, "reviewer", Reviewer);
        var basePath = CreateBase(main, good, refusing);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer", Confirmed: true));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var outcomes = (await response.Content.ReadFromJsonAsync<PerformerSyncResponse>())!.Copies;
        // Синхронизация трёх копий может пройти наполовину — по списку видно, где именно.
        Assert.True(Assert.Single(outcomes, o => o.Copy == good).Done);
        var failed = Assert.Single(outcomes, o => o.Copy == refusing);
        Assert.False(failed.Done);
        Assert.Contains("сверка не прошла", failed.Error);
        // Файл остался на диске, но не в индексе: иначе его унесла бы в свой коммит чужая сессия.
        Assert.Equal(["?? .claude/"], Status(refusing));
    }

    [Fact]
    public async Task Sync_RefusesWhenThePerformerIsNotInTheMainCopy()
    {
        var main = Repository("app");
        var second = Repository("app-two");
        // Исполнителя завели руками в чужой ветке: брать его оттуда панель не станет.
        Performer(second, "reviewer", Reviewer);
        var basePath = CreateBase(main, second);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "reviewer"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("not-in-main", (await response.Content.ReadFromJsonAsync<PerformerSyncRefusedResponse>())!.Problem);
    }

    [Fact]
    public async Task Sync_RefusesNameThatIsNotASubagentName()
    {
        var main = Repository("app");
        var basePath = CreateBase(main);

        var response = await Sync(basePath, new SyncPerformerRequest(basePath, "../../secrets"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-name", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
    }

    [Fact]
    public async Task Sync_RefusesBaseThatIsNotWatched()
    {
        var main = Repository("app");
        var stranger = Path.Combine(_root, "stranger-knowledge");
        Directory.CreateDirectory(stranger);

        await using var factory = Factory(CreateBase(main));
        var response = await factory.CreateClient().PostAsJsonAsync(
            "/api/performers/sync", new SyncPerformerRequest(stranger, "reviewer"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private string Repository(string name) => TestGit.Repository(Path.Combine(_root, name));

    private static void Performer(string copy, string name, string text)
    {
        var directory = Path.Combine(copy, ".claude", "agents");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, name + ".md"), text.ReplaceLineEndings("\n"));
    }

    private string CreateBase(params string[] copies)
    {
        var basePath = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        var json = System.Text.Json.JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies });
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), json);
        return basePath;
    }

    private static string Subject(string copy) => Run(copy, "log", "-1", "--format=%s").Trim();

    private static string[] Status(string copy) =>
        Run(copy, "status", "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray();

    private static string[] CommittedFiles(string copy) =>
        Run(copy, "show", "--name-only", "--format=").Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim()).ToArray();

    private static string Run(string workingDirectory, params string[] args)
    {
        // Сообщения коммитов панели по-русски: без UTF-8 вывод git читается кодировкой консоли и не сходится.
        var startInfo = new System.Diagnostics.ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = System.Diagnostics.Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return output.ReplaceLineEndings("\n");
    }

    private WebApplicationFactory<Program> Factory(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, bases)),
                    new("ClaudeDir", Path.Combine(_root, "profile")),
                ]);
            }));

    private async Task<HttpResponseMessage> Sync(string basePath, SyncPerformerRequest request)
    {
        await using var factory = Factory(basePath);
        return await factory.CreateClient().PostAsJsonAsync("/api/performers/sync", request);
    }

    public void Dispose()
    {
        try
        {
            // Объекты git лежат read-only: без снятия атрибутов каталог прогона не удаляется.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Каталог прогона держит git — временные файлы уберёт система.
        }
    }
}
