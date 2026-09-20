using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class RemoveWorkspaceTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-remove-copy-").FullName;
    private readonly string _main;
    private readonly string _copy;
    private readonly string _base;
    private readonly WebApplicationFactory<Program> _factory;

    // Заглушка кита пишет, с чем и откуда её позвали, и печатает то же, что настоящий скрипт.
    private const string Succeeds = """
        param([string]$Path)
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'called.txt') -Value "$Path|$((Get-Location).Path)" -Encoding utf8
        Write-Host "Рабочая копия удалена: $Path"
        Write-Host "Ветка осталась:        quiet-cedar в репозитории D:\Projects\app"
        """;

    public RemoveWorkspaceTests()
    {
        _main = TestGit.Repository(Path.Combine(_root, "app"));
        _copy = Path.Combine(_root, "quiet-cedar");
        TestGit.Run(_main, "worktree", "add", "-b", "quiet-cedar", _copy);

        _base = Directory.CreateDirectory(Path.Combine(_root, "app-knowledge")).FullName;
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"),
            System.Text.Json.JsonSerializer.Serialize(new { workspaces = new[] { _main } }));

        var file = TestBases.File(_root, _base);
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", file), new("HealthIntervalSeconds", "3600")]);
            }));
    }

    private HttpClient Client => _factory.CreateClient();

    [Fact]
    public async Task Remove_RunsKitWithCopyPathFromOutsideTheCopy()
    {
        var kit = await SetKit(Succeeds);

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var called = File.ReadAllText(Path.Combine(kit, "scripts", "called.txt")).Trim().Split('|');
        Assert.Equal(_copy, called[0]);
        // Кит отказывается удалять копию, внутри которой его запустили.
        Assert.False(called[1].StartsWith(_copy, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Remove_KitRefuses_ReturnsKitWordsInReadableCyrillic()
    {
        await SetKit("""
            param([string]$Path)
            throw "в копии «$Path» незакоммиченное: frontend/src/App.tsx — сначала закоммитить"
            """);

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            new RemoveWorkspaceRejectedResponse(
                RemoveWorkspaceProblem.Refused,
                $"в копии «{_copy}» незакоммиченное: frontend/src/App.tsx — сначала закоммитить"),
            await response.Content.ReadFromJsonAsync<RemoveWorkspaceRejectedResponse>());
    }

    [Fact]
    public async Task Remove_KitNotSet_IsRejected()
    {
        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            RemoveWorkspaceProblem.KitNotSet,
            (await response.Content.ReadFromJsonAsync<RemoveWorkspaceRejectedResponse>())!.Problem);
    }

    [Fact]
    public async Task Remove_KitWithoutScript_IsKitNotFound()
    {
        var kit = await SetKit(worktreeRemove: null);

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _copy));

        Assert.Equal(
            new RemoveWorkspaceRejectedResponse(RemoveWorkspaceProblem.KitNotFound, KitWorktreeRemove.ScriptFile(kit)),
            await response.Content.ReadFromJsonAsync<RemoveWorkspaceRejectedResponse>());
    }

    [Fact]
    public async Task Remove_CopyWithTaskInWork_IsRefusedWithoutCallingKit()
    {
        var kit = await SetKit(Succeeds);
        File.WriteAllText(Path.Combine(_base, "work", "quiet-cedar.md"), $"""
            # B-55 Оператор удаляет рабочую копию
            рабочая копия: {_copy}
            ветка: quiet-cedar
            """);

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(
            RemoveWorkspaceProblem.InWork,
            (await response.Content.ReadFromJsonAsync<RemoveWorkspaceRejectedResponse>())!.Problem);
        Assert.False(File.Exists(Path.Combine(kit, "scripts", "called.txt")));
    }

    [Fact]
    public async Task Remove_MainCopy_IsRefusedWithoutCallingKit()
    {
        var kit = await SetKit(Succeeds);

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, _main));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(
            RemoveWorkspaceProblem.MainCopy,
            (await response.Content.ReadFromJsonAsync<RemoveWorkspaceRejectedResponse>())!.Problem);
        Assert.False(File.Exists(Path.Combine(kit, "scripts", "called.txt")));
    }

    [Fact]
    public async Task Remove_CopyOutsideTheTable_IsNotFound()
    {
        await SetKit(Succeeds);
        var stranger = Directory.CreateDirectory(Path.Combine(_root, "stranger")).FullName;

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(_base, stranger));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Remove_BaseNotInList_IsNotFound()
    {
        await SetKit(Succeeds);
        var other = Directory.CreateDirectory(Path.Combine(_root, "other-knowledge")).FullName;

        var response = await Client.PostAsJsonAsync("/api/workspace/remove", new RemoveWorkspaceRequest(other, _copy));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private async Task<string> SetKit(string? worktreeRemove)
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"), worktreeRemove: worktreeRemove);
        (await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit))).EnsureSuccessStatusCode();
        return kit;
    }

    public void Dispose()
    {
        TestHost.Stop(_factory);
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (UnauthorizedAccessException)
        {
            // git оставляет файлы только для чтения в .git — их хвост во временном каталоге не мешает прогону.
        }
    }
}
