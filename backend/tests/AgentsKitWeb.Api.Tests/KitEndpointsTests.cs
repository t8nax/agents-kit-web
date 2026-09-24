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
    private readonly string _claude;
    private readonly WebApplicationFactory<Program> _factory;
    private readonly TestHosts _hosts = new();

    public KitEndpointsTests()
    {
        _file = Path.Combine(_root, "panel", "bases.json");
        _claude = Path.Combine(_root, "profile", ".claude");
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", _file), new("ClaudeDir", _claude)]);
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

        var factory = FactoryWithClaudeDir(claude);
        var found = await factory.CreateClient().GetFromJsonAsync<List<string>>("/api/kit/found");

        Assert.Equal([skillKit, pluginKit], found);
    }

    [Fact]
    public async Task FoundKits_NoProfile_IsEmpty()
    {
        var factory = FactoryWithClaudeDir(Path.Combine(_root, "nobody", ".claude"));

        Assert.Empty((await factory.CreateClient().GetFromJsonAsync<List<string>>("/api/kit/found"))!);
    }

    [Fact]
    public async Task Kit_CurrentPluginInstall_IsPluginWithVersionAndNoUpdate()
    {
        var kit = PluginKit("0.2.0");
        InstallPlugins(kit);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));

        Assert.Equal(new KitResponse(kit, true, "0.2.0", true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_PluginUpdatedAfterSet_OffersNewVersionAndKeepsSavedPath()
    {
        var old = PluginKit("0.2.0");
        InstallPlugins(old);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(old));

        var fresh = PluginKit("0.3.0");
        InstallPlugins(fresh);

        Assert.Equal(new KitResponse(old, true, "0.2.0", true, new KitVersion(fresh, "0.3.0")),
            await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_OldPluginVersionRemoved_OffersNewVersion()
    {
        var old = PluginKit("0.2.0");
        InstallPlugins(old);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(old));
        var fresh = PluginKit("0.3.0");
        InstallPlugins(fresh);

        Directory.Delete(old, recursive: true);

        Assert.Equal(new KitResponse(old, false, null, true, new KitVersion(fresh, "0.3.0")),
            await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_SwitchedToNewVersion_HasNoUpdate()
    {
        var old = PluginKit("0.2.0");
        InstallPlugins(old);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(old));
        var fresh = PluginKit("0.3.0");
        InstallPlugins(fresh);

        var response = await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(fresh));

        Assert.Equal(new KitResponse(fresh, true, "0.3.0", true), await response.Content.ReadFromJsonAsync<KitResponse>());
    }

    [Fact]
    public async Task Kit_NotFromPlugins_HasVersionAndNoUpdate()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        WriteVersion(kit, "0.10.3");
        InstallPlugins(PluginKit("0.3.0"));
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));

        Assert.Equal(new KitResponse(kit, true, "0.10.3"), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_PluginInTwoScopes_OlderInstallIsNotOffered()
    {
        var user = PluginKit("0.3.0");
        var project = PluginKit("0.2.0");
        InstallPlugins(user, project);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(user));

        Assert.Equal(new KitResponse(user, true, "0.3.0", true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Fact]
    public async Task Kit_SeveralNewerInstalls_OffersNewest()
    {
        var old = PluginKit("0.2.0");
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(old));
        var newest = PluginKit("0.10.0");
        InstallPlugins(PluginKit("0.9.1"), newest);

        Assert.Equal(new KitVersion(newest, "0.10.0"), (await Client.GetFromJsonAsync<KitResponse>("/api/kit"))!.Update);
    }

    [Fact]
    public async Task Kit_FolderNextToOtherPlugin_IsNotPlugin()
    {
        var projects = Path.Combine(_root, "projects");
        var kit = TestKit.Create(Path.Combine(projects, "agents-kit"));
        var other = Directory.CreateDirectory(Path.Combine(projects, "other-plugin")).FullName;
        InstallPlugins(other);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));

        Assert.Equal(new KitResponse(kit, true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{ \"version\": 3 }")]
    [InlineData("{ \"name\": \"agents-kit\" }")]
    public async Task Kit_PluginDescriptionUnreadable_VersionIsUnknown(string description)
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        Directory.CreateDirectory(Path.Combine(kit, ".claude-plugin"));
        File.WriteAllText(Path.Combine(kit, ".claude-plugin", "plugin.json"), description);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));

        Assert.Equal(new KitResponse(kit, true), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{ \"plugins\": { \"agents-kit@kits\": [ { \"installPath\": 7 } ] } }")]
    public async Task Kit_InstalledPluginsUnreadable_IsNotPlugin(string installed)
    {
        var kit = PluginKit("0.2.0");
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        File.WriteAllText(Path.Combine(_claude, "plugins", "installed_plugins.json"), installed);

        Assert.Equal(new KitResponse(kit, true, "0.2.0"), await Client.GetFromJsonAsync<KitResponse>("/api/kit"));
    }

    /// <summary>Каталог версии плагина кита — там, куда Claude Code кладёт установленные плагины.</summary>
    private string PluginKit(string version)
    {
        var kit = TestKit.Create(Path.Combine(_claude, "plugins", "cache", "kits", "agents-kit", version));
        WriteVersion(kit, version);
        return kit;
    }

    private static void WriteVersion(string kit, string version)
    {
        Directory.CreateDirectory(Path.Combine(kit, ".claude-plugin"));
        File.WriteAllText(Path.Combine(kit, ".claude-plugin", "plugin.json"),
            System.Text.Json.JsonSerializer.Serialize(new { name = "agents-kit", version }));
    }

    /// <summary>Записывает installed_plugins.json так, как его оставляет установка или обновление плагина.</summary>
    private void InstallPlugins(params string[] kits)
    {
        var plugins = Directory.CreateDirectory(Path.Combine(_claude, "plugins")).FullName;
        File.WriteAllText(Path.Combine(plugins, "installed_plugins.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            version = 2,
            plugins = new Dictionary<string, object[]>
            {
                ["agents-kit@kits"] = kits
                    .Select(kit => (object)new { scope = "user", installPath = kit, version = Path.GetFileName(kit) })
                    .ToArray(),
            },
        }));
    }

    private WebApplicationFactory<Program> FactoryWithClaudeDir(string claudeDir) =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", _file), new("ClaudeDir", claudeDir)]);
            })));

    public void Dispose()
    {
        TestHost.Stop(_factory);
        _hosts.Dispose();
        Directory.Delete(_root, recursive: true);
    }
}
