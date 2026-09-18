using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class KitEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-kit-").FullName;
    private readonly string _file;
    private readonly WebApplicationFactory<Program> _factory;

    public KitEndpointsTests()
    {
        _file = Path.Combine(_root, "panel", "bases.json");
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", _file)]);
            }));
    }

    private HttpClient Client => _factory.CreateClient();

    [Fact]
    public async Task Kit_NoFile_IsNotSet()
    {
        Assert.Equal(new KitResponse(null, false), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task SetKit_DirectoryWithKitScripts_IsSavedAndKeepsBases()
    {
        var basePath = Directory.CreateDirectory(Path.Combine(_root, "app-knowledge")).FullName;
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), """{ "workspaces": [] }""");
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(basePath));
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));

        var response = await Client.PutAsJsonAsync("/api/kit", new SetKitRequest($" {kit}\\ "));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new KitResponse(kit, true), await response.Content.ReadFromJsonAsync<KitResponse>());
        Assert.Equal(new KitResponse(kit, true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
        Assert.Equal([new BaseEntry(basePath, 0)], await Client.GetFromJsonAsync<List<BaseEntry>>("/api/bases"));
    }

    [Fact]
    public async Task AddBase_AfterKitIsSet_KeepsKit()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        var basePath = Directory.CreateDirectory(Path.Combine(_root, "app-knowledge")).FullName;
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), """{ "workspaces": [] }""");

        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(basePath));
        await Client.DeleteAsync($"/api/bases?path={Uri.EscapeDataString(basePath)}");

        Assert.Equal(new KitResponse(kit, true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Theory]
    [InlineData("", "empty")]
    [InlineData("   ", "empty")]
    [InlineData("relative\\agents-kit", "not-full-path")]
    public async Task SetKit_InvalidPath_IsBadRequestAndSavesNothing(string path, string problem)
    {
        var response = await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(path));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AddBaseRejectedResponse(problem), await response.Content.ReadFromJsonAsync<AddBaseRejectedResponse>());
        Assert.False(File.Exists(_file));
    }

    [Fact]
    public async Task SetKit_DirectoryWithoutKitScripts_IsBadRequestAndKeepsPreviousKit()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        var halfKit = Directory.CreateDirectory(Path.Combine(_root, "half", "scripts")).Parent!.FullName;
        File.WriteAllText(Path.Combine(halfKit, "scripts", "base-check.ps1"), "");

        var response = await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(halfKit));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AddBaseRejectedResponse("not-a-kit"), await response.Content.ReadFromJsonAsync<AddBaseRejectedResponse>());
        Assert.Equal(new KitResponse(kit, true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_RemovedAfterSet_IsNotFound()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));

        Directory.Delete(kit, recursive: true);

        Assert.Equal(new KitResponse(kit, false), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task FoundKits_LooksInSkillsAndInstalledPluginsAndKeepsOnlyKits()
    {
        var claude = Path.Combine(_root, "profile", ".claude");
        var skillKit = TestKit.Create(Path.Combine(claude, "skills", "agents-kit"));
        Directory.CreateDirectory(Path.Combine(claude, "skills", "other-skill"));
        var pluginKit = TestKit.Create(Path.Combine(claude, "plugins", "cache", "kits", "agents-kit", "0.2.0"));
        var brokenPlugin = Directory.CreateDirectory(Path.Combine(claude, "plugins", "cache", "kits", "agents-kit", "0.1.0")).FullName;
        File.WriteAllText(Path.Combine(claude, "plugins", "installed_plugins.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            version = 2,
            plugins = new Dictionary<string, object[]>
            {
                ["agents-kit@kits"] = [new { installPath = pluginKit }, new { installPath = brokenPlugin }],
                ["duplicate@kits"] = [new { installPath = skillKit + "\\" }],
            },
        }));

        using var factory = FactoryWithClaudeDir(claude);
        var found = await factory.CreateClient().GetFromJsonAsync<List<string>>("/api/kit/found");

        Assert.Equal([skillKit, pluginKit], found);
    }

    [Fact]
    public async Task FoundKits_NoProfile_IsEmpty()
    {
        using var factory = FactoryWithClaudeDir(Path.Combine(_root, "nobody", ".claude"));

        Assert.Empty((await factory.CreateClient().GetFromJsonAsync<List<string>>("/api/kit/found"))!);
    }

    private WebApplicationFactory<Program> FactoryWithClaudeDir(string claudeDir) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", _file), new("ClaudeDir", claudeDir)]);
            }));

    public void Dispose()
    {
        TestHost.Stop(_factory);
        Directory.Delete(_root, recursive: true);
    }
}
