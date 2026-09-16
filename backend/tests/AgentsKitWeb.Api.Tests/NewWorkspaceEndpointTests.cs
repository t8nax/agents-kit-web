using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Скрипт кита подменяется своим worktree-add.ps1 во временном каталоге: настоящий завёл бы
/// рабочую копию рядом с живым проектом оператора.
/// </summary>
public sealed class NewWorkspaceEndpointTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-new-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _scripts;
    private WebApplicationFactory<Program>? _factory;

    public NewWorkspaceEndpointTests()
    {
        _base = Path.Combine(_root, "app-knowledge");
        _copy = Path.Combine(_root, "app");
        Directory.CreateDirectory(_copy);
        Directory.CreateDirectory(_base);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), JsonSerializer.Serialize(new { workspaces = new[] { _copy } }));
        _scripts = Directory.CreateDirectory(Path.Combine(_root, "scripts")).FullName;
    }

    [Fact]
    public async Task Post_WithName_RunsKitScriptWithCopyAndName()
    {
        var log = ScriptWritingRun();

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, " quiet-cedar "));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal($"{_copy}|quiet-cedar", (await File.ReadAllTextAsync(log)).Trim());
    }

    [Fact]
    public async Task Post_WithoutName_RunsKitScriptWithoutName()
    {
        var log = ScriptWritingRun();

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "   "));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal($"{_copy}|", (await File.ReadAllTextAsync(log)).Trim());
    }

    [Fact]
    public async Task Post_ScriptRefuses_IsBadRequestWithItsOwnText()
    {
        Script("throw \"ветка «quiet-cedar» уже существует — назвать копию иначе\"");

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "quiet-cedar"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            new NewWorkspaceRejectedResponse("script", "ветка «quiet-cedar» уже существует — назвать копию иначе"),
            await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>());
    }

    [Theory]
    [InlineData("Quiet-Cedar")]
    [InlineData("quiet cedar")]
    [InlineData("quiet_cedar")]
    [InlineData("-quiet")]
    public async Task Post_NameNotKebabCase_IsBadRequestAndScriptNotRun(string name)
    {
        var log = ScriptWritingRun();

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, name));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new NewWorkspaceRejectedResponse("bad-name", null),
            await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>());
        Assert.False(File.Exists(log));
    }

    [Fact]
    public async Task Post_BaseNotInList_IsNotFoundAndScriptNotRun()
    {
        var log = ScriptWritingRun();
        var other = Directory.CreateDirectory(Path.Combine(_root, "other-knowledge")).FullName;

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(other, "quiet-cedar"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.False(File.Exists(log));
    }

    [Fact]
    public async Task Post_NoCopyOnDisk_IsBadRequestAndScriptNotRun()
    {
        var log = ScriptWritingRun();
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { workspaces = new[] { Path.Combine(_root, "gone") } }));

        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "quiet-cedar"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new NewWorkspaceRejectedResponse("no-copy", null),
            await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>());
        Assert.False(File.Exists(log));
    }

    [Fact]
    public async Task Post_KitScriptMissing_IsBadRequestNamingTheFile()
    {
        var response = await Client().PostAsJsonAsync("/api/workspaces", new NewWorkspaceRequest(_base, "quiet-cedar"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<NewWorkspaceRejectedResponse>();
        Assert.Equal("kit-missing", body!.Problem);
        Assert.Equal(Path.Combine(_scripts, "worktree-add.ps1"), body.Message);
    }

    /// <summary>Подменённый скрипт: пишет в файл, с какой копией и каким именем его позвали.</summary>
    private string ScriptWritingRun()
    {
        var log = Path.Combine(_root, "run.txt");
        Script($"\"$Path|$Name\" | Set-Content -LiteralPath '{log}'");
        return log;
    }

    private void Script(string body) =>
        File.WriteAllText(Path.Combine(_scripts, "worktree-add.ps1"),
            $"param([string]$Name, [string]$Path)\n$ErrorActionPreference = 'Stop'\n{body}\n");

    private HttpClient Client()
    {
        _factory ??= new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, _base)),
                    new("KitScripts", _scripts),
                ]);
            }));
        return _factory.CreateClient();
    }

    public void Dispose()
    {
        _factory?.Dispose();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
