using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Flow;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PresetsEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-presets-").FullName;
    private readonly WebApplicationFactory<Program> _factory;

    public PresetsEndpointsTests()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root))]);
            }));
    }

    private HttpClient Client => _factory.CreateClient();

    [Fact]
    public async Task Presets_StartEmpty()
    {
        Assert.Empty(await GetPresets());
    }

    [Fact]
    public async Task Add_SavesStepWithDescriptionBesideBasesFile()
    {
        var step = new FlowStage(" Ревью ", "reviewer", "вердикт по sha", "правка только в текстах", "2.1. Собрать дифф.\n   2.1.1. Всей ветки.");

        var response = await Client.PostAsJsonAsync("/api/presets", step);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var preset = await response.Content.ReadFromJsonAsync<StepPreset>();
        Assert.Equal("Ревью", preset!.Title);
        Assert.Equal("2.1. Собрать дифф.\n   2.1.1. Всей ветки.", preset.Description);
        Assert.Equal([preset], await GetPresets());
        Assert.True(File.Exists(Path.Combine(_root, "panel", "presets.json")));
    }

    [Fact]
    public async Task Add_SameStepTwice_KeepsOnePreset()
    {
        var step = new FlowStage("Мерж", "оркестратор", "sha в dev", null, null);

        var first = await (await Client.PostAsJsonAsync("/api/presets", step)).Content.ReadFromJsonAsync<StepPreset>();
        var second = await (await Client.PostAsJsonAsync("/api/presets", step)).Content.ReadFromJsonAsync<StepPreset>();

        Assert.Equal(first, second);
        Assert.Single(await GetPresets());
    }

    [Fact]
    public async Task Add_StepBreakingKitForm_IsBadRequest()
    {
        var response = await Client.PostAsJsonAsync("/api/presets", new FlowStage("Мерж", "оркестратор", "", null, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(await GetPresets());
    }

    [Fact]
    public async Task Remove_DeletesPresetAndUnknownIsNotFound()
    {
        var kept = await (await Client.PostAsJsonAsync("/api/presets", new FlowStage("Ветка", "оркестратор", "имя ветки", null, null)))
            .Content.ReadFromJsonAsync<StepPreset>();
        var removed = await (await Client.PostAsJsonAsync("/api/presets", new FlowStage("Мерж", "оркестратор", "sha", null, null)))
            .Content.ReadFromJsonAsync<StepPreset>();

        Assert.Equal(HttpStatusCode.NoContent, (await Client.DeleteAsync($"/api/presets/{removed!.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Client.DeleteAsync($"/api/presets/{removed.Id}")).StatusCode);
        Assert.Equal([kept], await GetPresets());
    }

    private async Task<List<StepPreset>> GetPresets() =>
        await Client.GetFromJsonAsync<List<StepPreset>>("/api/presets") ?? [];

    public void Dispose()
    {
        TestHost.Stop(_factory);
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
