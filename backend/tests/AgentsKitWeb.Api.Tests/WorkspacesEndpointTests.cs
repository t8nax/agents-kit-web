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

            ### Флоу
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

            ### Флоу
            - [ ] 1. Критерий
            """);

        var row = Assert.Single(await GetRows(basePath));
        Assert.Equal("solo-knowledge", row.Project);
        Assert.Equal(WorkspaceStatus.InWork, row.Status);
        Assert.Equal("Критерий", row.FlowStep);
        Assert.Equal(0, row.Progress);
    }

    [Fact]
    public async Task Workspaces_NoBasesConfigured_ReturnsEmptyList()
    {
        Assert.Empty(await GetRows());
    }

    private string CreateBase(string name, params string[] copies)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        var json = System.Text.Json.JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies });
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), json);
        return basePath;
    }

    private async Task<List<WorkspaceRow>> GetRows(params string[] bases)
    {
        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            }));
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/workspaces");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<List<WorkspaceRow>>() ?? [];
    }

    private static void Git(string workingDirectory, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)!;
        var stderr = process.StandardError.ReadToEnd();
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"git {string.Join(' ', args)}: {stderr}");
    }

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
