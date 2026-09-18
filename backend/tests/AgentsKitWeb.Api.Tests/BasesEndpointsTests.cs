using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class BasesEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-bases-").FullName;
    private readonly string _file;
    private readonly WebApplicationFactory<Program> _factory;

    public BasesEndpointsTests()
    {
        _file = Path.Combine(_root, "panel", "bases.json");
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", _file)]);
            }));
    }

    [Fact]
    public async Task Bases_NoFile_IsEmptyList()
    {
        Assert.Empty(await GetBases());
    }

    [Fact]
    public async Task Add_BaseWithAgentsKitJson_IsSavedWithCopiesAndShownInWorkspaces()
    {
        var basePath = CreateBase("app-knowledge", Path.Combine(_root, "gone"));

        var response = await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest($" {basePath}\\ "));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(new BaseEntry(basePath, 1), await response.Content.ReadFromJsonAsync<BaseEntry>());
        Assert.Equal([new BaseEntry(basePath, 1)], await GetBases());
        Assert.True(File.Exists(_file));

        var rows = await Client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        Assert.Equal("Копия не найдена на диске", Assert.Single(rows!).Error);
    }

    [Theory]
    [InlineData("", "empty")]
    [InlineData("   ", "empty")]
    [InlineData("relative\\app-knowledge", "not-full-path")]
    public async Task Add_InvalidPath_IsBadRequestAndSavesNothing(string path, string problem)
    {
        var response = await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(path));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AddBaseRejectedResponse(problem), await response.Content.ReadFromJsonAsync<AddBaseRejectedResponse>());
        Assert.False(File.Exists(_file));
    }

    [Fact]
    public async Task Add_DirectoryWithoutAgentsKitJson_IsBadRequestAndSavesNothing()
    {
        var plain = Directory.CreateDirectory(Path.Combine(_root, "app")).FullName;

        var response = await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(plain));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AddBaseRejectedResponse("not-a-base"), await response.Content.ReadFromJsonAsync<AddBaseRejectedResponse>());
        Assert.Empty(await GetBases());
    }

    [Fact]
    public async Task Add_SameBaseInOtherCase_IsConflict()
    {
        var basePath = CreateBase("app-knowledge");
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(basePath));

        var response = await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(basePath.ToUpperInvariant()));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(new AddBaseRejectedResponse("duplicate"), await response.Content.ReadFromJsonAsync<AddBaseRejectedResponse>());
        Assert.Single(await GetBases());
    }

    [Fact]
    public async Task Remove_Base_DropsItFromListAndWorkspaces()
    {
        var first = CreateBase("a-knowledge", Path.Combine(_root, "a"));
        var second = CreateBase("b-knowledge", Path.Combine(_root, "b"));
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(first));
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(second));

        var response = await Client.DeleteAsync($"/api/bases?path={Uri.EscapeDataString(first)}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([second], (await GetBases()).Select(b => b.Path));
        var rows = await Client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        Assert.Equal("b-knowledge", Assert.Single(rows!).Project);
    }

    [Fact]
    public async Task Remove_UnknownBase_IsNotFound()
    {
        var response = await Client.DeleteAsync($"/api/bases?path={Uri.EscapeDataString(Path.Combine(_root, "nope"))}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Answers_BaseRemovedFromList_IsNotFound()
    {
        var copy = Path.Combine(_root, "app");
        var basePath = CreateBase("app-knowledge");
        await File.WriteAllTextAsync(Path.Combine(basePath, "work", "app.md"),
            $"# Задача\nрабочая копия: {copy}\n\n- Оператору: Вопрос?\n  - контекст: к\n");
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(basePath));
        await Client.DeleteAsync($"/api/bases?path={Uri.EscapeDataString(basePath)}");

        var response = await Client.PostAsJsonAsync("/api/answers",
            new AnswersRequest(basePath, copy, [new OperatorAnswer("Вопрос?", "да")]));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private HttpClient Client => _factory.CreateClient();

    private async Task<List<BaseEntry>> GetBases() =>
        await Client.GetFromJsonAsync<List<BaseEntry>>("/api/bases") ?? [];

    private string CreateBase(string name, params string[] copies)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"),
            System.Text.Json.JsonSerializer.Serialize(new { workspaces = copies }));
        return basePath;
    }

    public void Dispose()
    {
        TestHost.Stop(_factory);
        Directory.Delete(_root, recursive: true);
    }
}
