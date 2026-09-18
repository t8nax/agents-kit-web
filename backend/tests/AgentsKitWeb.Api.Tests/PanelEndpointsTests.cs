using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PanelEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-panel-").FullName;

    [Fact]
    public async Task Panel_WithoutPublishedFile_IsDevelopmentRun()
    {
        using var factory = Factory(Path.Combine(_root, "published.json"));

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.False(panel.Installed);
        Assert.Null(panel.Channel);
        // Номер приходит из version.txt репозитория, зашитого в сборку.
        Assert.Matches(@"^\d+\.\d+\.\d+$", panel.Version);
    }

    [Fact]
    public async Task Panel_WithPublishedFile_TellsChannelAndBuild()
    {
        var file = Path.Combine(_root, "published.json");
        var built = new DateTimeOffset(2026, 9, 12, 19, 40, 0, TimeSpan.Zero);
        Published(file, new PublishedPanel("master", "origin/master", "4189d1f", "1.0.0", built, @"D:\Projects\agents-kit-web"));
        using var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.True(panel.Installed);
        Assert.Equal("master", panel.Channel);
        Assert.Equal("4189d1f", panel.Sha);
        Assert.Equal(built, panel.BuiltAt);
    }

    [Fact]
    public async Task Panel_WithBrokenPublishedFile_FallsBackToDevelopmentRun()
    {
        var file = Path.Combine(_root, "published.json");
        File.WriteAllText(file, "не json");
        using var factory = Factory(file);

        var panel = await factory.CreateClient().GetFromJsonAsync<PanelResponse>("/api/panel");

        Assert.NotNull(panel);
        Assert.False(panel.Installed);
    }

    private WebApplicationFactory<Program> Factory(string publishedFile) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", publishedFile),
                ]);
            }));

    private static void Published(string file, PublishedPanel panel) =>
        File.WriteAllText(file, JsonSerializer.Serialize(panel, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }));

    public void Dispose() => Directory.Delete(_root, recursive: true);
}
