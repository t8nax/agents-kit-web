using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class WorkspacesEndpointTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-tests-").FullName;

    [Fact]
    public async Task Workspaces_ReturnsRowPerCopyAndWorktree()
    {
        var main = Path.Combine(_root, "app");
        var worktree = Path.Combine(_root, "app-wt");
        Directory.CreateDirectory(main);
        Git(main, "init", "-b", "dev");
        Git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
        Git(main, "worktree", "add", "-b", "feat/wt", worktree);

        var missingCopy = Path.Combine(_root, "gone");
        var basePath = CreateBase("app-knowledge", main, missingCopy);
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");
        File.WriteAllText(Path.Combine(basePath, "work", "app.md"), $"""
            # Таблица рабочих копий
            рабочая копия: {main}
            ветка: dev

            ## Оператору

            ### Подтвердите критерий
            За вами объём.

            ответ:

            ## Агенту

            ### Сценарий
            - [x] 1. Критерий — выход: да
            - [ ] 2. Ветка
            - [ ] 3. Реализация
            - [ ] 4. Приёмка
            """);

        var missingBase = Path.Combine(_root, "no-base");
        var rows = await GetRows(basePath, missingBase);

        Assert.Equal(4, rows.Count);

        var mainRow = Assert.Single(rows, r => r.Path == main);
        Assert.Equal("Order Service", mainRow.Project);
        Assert.Equal("dev", mainRow.Branch);
        Assert.Equal("Таблица рабочих копий", mainRow.Task);
        Assert.Equal("Ветка", mainRow.FlowStep);
        Assert.Equal(25, mainRow.Progress);
        Assert.Equal(WorkspaceStatus.Waiting, mainRow.Status);
        Assert.Null(mainRow.Error);

        var worktreeRow = Assert.Single(rows, r => r.Path == worktree);
        Assert.Equal("feat/wt", worktreeRow.Branch);
        Assert.Equal(WorkspaceStatus.Free, worktreeRow.Status);
        Assert.Null(worktreeRow.Task);
        Assert.Null(worktreeRow.Progress);

        var missingCopyRow = Assert.Single(rows, r => r.Path == missingCopy);
        Assert.Equal("Копия не найдена на диске", missingCopyRow.Error);
        Assert.Equal("Order Service", missingCopyRow.Project);
        Assert.Null(missingCopyRow.Status);

        var missingBaseRow = Assert.Single(rows, r => r.Path == missingBase);
        Assert.Equal("База не найдена на диске", missingBaseRow.Error);
        Assert.Equal("no-base", missingBaseRow.Project);
    }

    [Fact]
    public async Task Workspaces_MemoryWithoutAnswerPendingIsInWork()
    {
        var copy = Path.Combine(_root, "solo");
        Directory.CreateDirectory(copy);
        Git(copy, "init", "-b", "dev");

        var basePath = CreateBase("solo-knowledge", copy);
        File.WriteAllText(Path.Combine(basePath, "work", "solo.md"), $"""
            # Задача
            рабочая копия: {copy.Replace('\\', '/')}

            ## Оператору

            ### Вопрос
            Контекст.

            ответ: ответ

            ## Агенту

            ### Сценарий
            - [ ] 1. Критерий
            """);

        var row = Assert.Single(await GetRows(basePath));
        Assert.Equal("solo-knowledge", row.Project);
        Assert.Equal(WorkspaceStatus.InWork, row.Status);
        Assert.Equal("Критерий", row.FlowStep);
        Assert.Equal(0, row.Progress);
    }

    [Fact]
    public async Task Workspaces_CopyIsRepositoryDirectory_RowPerWorktreeWithThatDirectory()
    {
        var main = Path.Combine(_root, "mono");
        Directory.CreateDirectory(main);
        Git(main, "init", "-b", "dev");
        Git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");

        // Ветка без каталога под китом: заведена до того, как каталог появился.
        var withoutDirectory = Path.Combine(_root, "mono-old");
        Git(main, "worktree", "add", "-b", "feat/old", withoutDirectory);

        Directory.CreateDirectory(Path.Combine(main, "packages", "foo"));
        File.WriteAllText(Path.Combine(main, "packages", "foo", "readme.md"), "foo\n");
        Git(main, "add", "packages/foo/readme.md");
        Git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "foo");

        var withDirectory = Path.Combine(_root, "mono-wt");
        Git(main, "worktree", "add", "-b", "feat/wt", withDirectory);

        var copy = Path.Combine(main, "packages", "foo");
        var basePath = CreateBase("mono-knowledge", copy);
        File.WriteAllText(Path.Combine(basePath, "work", "mono-packages-foo.md"), $"""
            # Разбор накладной
            рабочая копия: {copy}

            ## Агенту

            ### Сценарий
            - [x] 1. Критерий — выход: да
            - [ ] 2. Ветка
            """);

        var rows = await GetRows(basePath);

        Assert.Equal(2, rows.Count);

        var mainRow = Assert.Single(rows, r => r.Path == copy);
        Assert.Equal("dev", mainRow.Branch);
        Assert.Equal("Разбор накладной", mainRow.Task);
        Assert.Equal(WorkspaceStatus.InWork, mainRow.Status);

        var worktreeRow = Assert.Single(rows, r => r.Path == Path.Combine(withDirectory, "packages", "foo"));
        Assert.Equal("feat/wt", worktreeRow.Branch);
        Assert.Equal(WorkspaceStatus.Free, worktreeRow.Status);

        Assert.DoesNotContain(rows, r => r.Path.StartsWith(withoutDirectory, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(rows, r => r.Path == main || r.Path == withDirectory);
    }

    [Fact]
    public async Task Workspaces_NoBasesConfigured_ReturnsEmptyList()
    {
        Assert.Empty(await GetRows());
    }

    /// <summary>
    /// Переход в терминал есть только у копии, где сессию задачи завела сама панель: в чужую сессию
    /// копии он не ведёт.
    /// </summary>
    [Fact]
    public async Task Workspaces_CopyWithTheSessionThePanelStarted_IsMarked()
    {
        var withSession = Path.Combine(_root, "busy");
        var withoutSession = Path.Combine(_root, "quiet");
        foreach (var copy in new[] { withSession, withoutSession })
        {
            Directory.CreateDirectory(copy);
            Git(copy, "init", "-b", "dev");
        }

        var basePath = CreateBase("sessions-knowledge", withSession, withoutSession);
        var sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(sessionsDir);
        // Живой считается сессия, чей процесс существует, поэтому в фикстуре стоит pid самого прогона.
        File.WriteAllText(
            Path.Combine(sessionsDir, "bg.json"),
            $$"""{"pid":{{Environment.ProcessId}},"cwd":{{System.Text.Json.JsonSerializer.Serialize(withSession)}},"entrypoint":"cli","kind":"bg","jobId":"7339dced"}""");

        TestBases.TaskSession(_root, withSession, "7339dced");

        var rows = await GetRows(sessionsDir, [basePath]);

        Assert.True(Assert.Single(rows, r => r.Path == withSession).BackgroundSession);
        Assert.False(Assert.Single(rows, r => r.Path == withoutSession).BackgroundSession);
    }

    /// <summary>Строка копии несёт состояние сессии её задачи, а копия без такой сессии — ничего.</summary>
    [Fact]
    public async Task Workspaces_CopyWithTaskSession_CarriesItsState()
    {
        var withSession = Path.Combine(_root, "asking");
        var withoutSession = Path.Combine(_root, "empty");
        foreach (var copy in new[] { withSession, withoutSession })
        {
            Directory.CreateDirectory(copy);
            Git(copy, "init", "-b", "dev");
        }

        var basePath = CreateBase("state-knowledge", withSession, withoutSession);
        var sessionsDir = SessionsDirWith(withSession, "waiting", ProcessStart);
        TestBases.TaskSession(_root, withSession, "7339dced");

        var rows = await GetRows(sessionsDir, [basePath]);

        Assert.Equal(SessionState.Waiting, Assert.Single(rows, r => r.Path == withSession).SessionState);
        Assert.Null(Assert.Single(rows, r => r.Path == withoutSession).SessionState);
    }

    /// <summary>
    /// Файл брошенной сессии остаётся на диске, а её номер процесса Windows отдаёт другой программе:
    /// такая запись живой сессией не считается.
    /// </summary>
    [Fact]
    public async Task Workspaces_SessionFileWhosePidWasTakenByAnotherProgram_IsNotLive()
    {
        var copy = Path.Combine(_root, "abandoned");
        Directory.CreateDirectory(copy);
        Git(copy, "init", "-b", "dev");

        var basePath = CreateBase("abandoned-knowledge", copy);
        var sessionsDir = SessionsDirWith(copy, "busy", ProcessStart + 1);
        TestBases.TaskSession(_root, copy, "7339dced");

        var rows = await GetRows(sessionsDir, [basePath]);

        Assert.Null(Assert.Single(rows, r => r.Path == copy).SessionState);
    }

    /// <summary>Время старта процесса прогона — то же, что панель спросит у Windows по его номеру.</summary>
    private static long ProcessStart =>
        System.Diagnostics.Process.GetCurrentProcess().StartTime.ToFileTimeUtc();

    /// <summary>Каталог сессий с одной записью о копии; pid прогона делает её процесс заведомо живым.</summary>
    private string SessionsDirWith(string copy, string status, long procStart)
    {
        var dir = Path.Combine(_root, $"sessions-{status}-{procStart}");
        Directory.CreateDirectory(dir);
        File.WriteAllText(
            Path.Combine(dir, $"{Environment.ProcessId}.json"),
            $$"""
            {"pid":{{Environment.ProcessId}},"cwd":{{System.Text.Json.JsonSerializer.Serialize(copy)}},"entrypoint":"cli","kind":"bg","jobId":"7339dced","status":"{{status}}","procStart":"{{procStart}}"}
            """);
        return dir;
    }

    private string CreateBase(string name, params string[] copies)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        var json = System.Text.Json.JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies });
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), json);
        return basePath;
    }

    private Task<List<WorkspaceRow>> GetRows(params string[] bases) => GetRows(sessionsDir: null, bases);

    private async Task<List<WorkspaceRow>> GetRows(string? sessionsDir, string[] bases)
    {
        var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(sessionsDir is null
                    ? [new("BasesFile", TestBases.File(_root, bases))]
                    : [new("BasesFile", TestBases.File(_root, bases)), new("SessionsDir", sessionsDir)]);
            }));
        try
        {
            var response = await factory.CreateClient().GetAsync("/api/workspaces");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return await response.Content.ReadFromJsonAsync<List<WorkspaceRow>>() ?? [];
        }
        finally
        {
            TestHost.Stop(factory);
        }
    }

    private static void Git(string workingDirectory, params string[] args) =>
        TestGit.Run(workingDirectory, args);

    public void Dispose()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
