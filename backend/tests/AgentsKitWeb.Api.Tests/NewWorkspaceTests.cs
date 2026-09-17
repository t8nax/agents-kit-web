using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class NewWorkspaceTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-new-copy-").FullName;
    private readonly string _main;
    private readonly string _base;
    private readonly WebApplicationFactory<Program> _factory;

    // Заглушка кита пишет, с чем её позвали, и печатает то же, что настоящий скрипт.
    private const string Succeeds = """
        param([string]$Name, [string]$Path)
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'called.txt') -Value "$Path|$Name" -Encoding utf8
        if (-not $Name) { $Name = 'brave-sunny-otter' }
        Write-Host "Рабочая копия заведена: D:\Projects\$Name"
        Write-Host "Ветка:                  $Name"
        """;

    public NewWorkspaceTests()
    {
        _main = TestGit.Repository(Path.Combine(_root, "app"));
        _base = Directory.CreateDirectory(Path.Combine(_root, "app-knowledge")).FullName;
        var gone = Path.Combine(_root, "gone");
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"),
            System.Text.Json.JsonSerializer.Serialize(new { workspaces = new[] { gone, _main } }));

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
    public async Task Create_WithName_RunsKitFromFirstCopyOnDisk()
    {
        var kit = await SetKit(Succeeds);

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, " quiet-cedar "));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("quiet-cedar", (await response.Content.ReadFromJsonAsync<NewWorkspaceResponse>())!.Name);
        Assert.Equal($"{_main}|quiet-cedar", File.ReadAllText(Path.Combine(kit, "scripts", "called.txt")).Trim());
    }

    [Fact]
    public async Task Create_WithoutName_KitPicksName()
    {
        var kit = await SetKit(Succeeds);

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "  "));

        Assert.Equal("brave-sunny-otter", (await response.Content.ReadFromJsonAsync<NewWorkspaceResponse>())!.Name);
        Assert.Equal($"{_main}|", File.ReadAllText(Path.Combine(kit, "scripts", "called.txt")).Trim());
    }

    [Fact]
    public async Task Create_KitRefuses_ReturnsKitWordsInReadableCyrillic()
    {
        await SetKit("""
            param([string]$Name, [string]$Path)
            throw "ветка «$Name» уже существует — назвать копию иначе"
            """);

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "quiet-cedar"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            new NewWorkspaceRejectedResponse(NewWorkspaceProblem.Refused, "ветка «quiet-cedar» уже существует — назвать копию иначе"),
            await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>());
    }

    [Fact]
    public async Task Create_KitNotSet_IsRejected()
    {
        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(NewWorkspaceProblem.KitNotSet, (await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>())!.Problem);
    }

    [Fact]
    public async Task Create_KitWithoutScript_IsKitNotFound()
    {
        var kit = await SetKit(worktreeAdd: null);

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, null));

        Assert.Equal(
            new NewWorkspaceRejectedResponse(NewWorkspaceProblem.KitNotFound, KitWorktreeAdd.ScriptFile(kit)),
            await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>());
    }

    [Fact]
    public async Task Create_NoCopyOnDisk_IsRejected()
    {
        await SetKit(Succeeds);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), """{ "workspaces": ["Z:\\nowhere"] }""");

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, null));

        Assert.Equal(NewWorkspaceProblem.NoCopy, (await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>())!.Problem);
    }

    [Fact]
    public async Task Create_BaseNotInList_IsNotFound()
    {
        await SetKit(Succeeds);
        var other = Directory.CreateDirectory(Path.Combine(_root, "other-knowledge")).FullName;

        var response = await Client.PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(other, null));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Workspaces_SourceCopyCarriesDirectoryOfNewCopies()
    {
        var worktree = Path.Combine(_root, "app-wt");
        TestGit.Run(_main, "worktree", "add", "-b", "feat/wt", worktree);

        var rows = (await Client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces"))!;

        Assert.Equal(_root, Assert.Single(rows, r => r.Path == _main).CopiesDir);
        Assert.Null(Assert.Single(rows, r => r.Path == worktree).CopiesDir);
        Assert.Null(Assert.Single(rows, r => r.Error is not null).CopiesDir);
    }

    [Theory]
    [InlineData("Рабочая копия заведена: D:\\x\r\nВетка:                  quiet-cedar\r\n", "quiet-cedar")]
    [InlineData("что-то другое\n", null)]
    public void BranchName_ReadsKitLine(string output, string? expected) =>
        Assert.Equal(expected, KitWorktreeAdd.BranchName(output));

    private async Task<string> SetKit(string? worktreeAdd)
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"), worktreeAdd: worktreeAdd);
        (await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit))).EnsureSuccessStatusCode();
        return kit;
    }

    public void Dispose()
    {
        _factory.Dispose();
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
