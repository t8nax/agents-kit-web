using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PanelUpdateTests : IDisposable
{
    private static readonly DateTimeOffset Built = new(2026, 9, 12, 19, 40, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-update-").FullName;

    [Fact]
    public void Log_IsKeptBesideThePanelDirectory()
    {
        // Каталог панели сносится подменой — журнал внутри него не пережил бы обновление.
        var file = PanelUpdateRunner.FileBeside(@"C:\app\panel\published.json");

        Assert.Equal(@"C:\app\update.log", file);
    }

    [Theory]
    [InlineData("публикация канала dev\n[конец] готово 1.2.0", PanelUpdateStates.Done, "1.2.0")]
    [InlineData("публикация канала dev\nошибка сборки\n[конец] сорвалось", PanelUpdateStates.Failed, null)]
    [InlineData("публикация канала dev\nnpm ci", PanelUpdateStates.Running, null)]
    [InlineData("", PanelUpdateStates.None, null)]
    public async Task Update_TellsWhatTheLogSays(string log, string state, string? version)
    {
        var file = Path.Combine(_root, "update.log");
        if (log.Length > 0)
            File.WriteAllText(file, log);
        using var factory = Factory(Published(Standing()), file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdateState>("/api/panel/update");

        Assert.Equal(state, update?.State);
        Assert.Equal(version, update?.Version);
    }

    [Fact]
    public async Task Update_Started_RunsTheScriptOfItsRepository()
    {
        var repository = Repository();
        var file = Path.Combine(_root, "update.log");
        using var factory = Factory(Published(repository), file);

        var response = await factory.CreateClient().PostAsync("/api/panel/update", null);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var finished = await Finished(factory);
        Assert.Equal(PanelUpdateStates.Done, finished.State);
        Assert.Equal("9.9.9", finished.Version);
        // Скрипт получил то, что панель знает о себе: канал, каталог, порт и имя своей задачи.
        Assert.Contains("канал master", finished.Log);
        Assert.Contains(@"панель C:\panel\app на 5080, задача agents-kit-web panel", finished.Log);
    }

    [Fact]
    public async Task Update_WhileRunning_IsNotStartedTwice()
    {
        var file = Path.Combine(_root, "update.log");
        File.WriteAllText(file, "публикация канала master\nnpm ci");
        using var factory = Factory(Published(Repository()), file);

        var response = await factory.CreateClient().PostAsync("/api/panel/update", null);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Update_OnDevelopmentRun_IsNotStarted()
    {
        using var factory = Factory(Path.Combine(_root, "published.json"), Path.Combine(_root, "update.log"));

        var response = await factory.CreateClient().PostAsync("/api/panel/update", null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// <summary>Ждёт, пока обновление допишет журнал: в прогоне это заглушка и кончается сразу.</summary>
    private static async Task<PanelUpdateState> Finished(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        while (true)
        {
            var update = await client.GetFromJsonAsync<PanelUpdateState>("/api/panel/update", deadline.Token);
            if (update is not null && update.State != PanelUpdateStates.Running)
                return update;
            await Task.Delay(200, deadline.Token);
        }
    }

    /// <summary>Каталог с заглушкой update.ps1 вместо настоящей: та собрала бы и подменила панель.</summary>
    private string Repository()
    {
        var repository = Directory.CreateDirectory(Path.Combine(_root, "repo")).FullName;
        var scripts = Directory.CreateDirectory(Path.Combine(repository, "scripts")).FullName;
        File.WriteAllText(Path.Combine(scripts, "update.ps1"), """
            param($Channel, $Target, $Port, $TaskName, $Log)
            Add-Content -LiteralPath $Log -Value "канал $Channel"
            Add-Content -LiteralPath $Log -Value "панель $Target на $Port, задача $TaskName"
            Add-Content -LiteralPath $Log -Value '[конец] готово 9.9.9'
            """);
        return repository;
    }

    private string Standing() => Directory.CreateDirectory(Path.Combine(_root, "repo")).FullName;

    private string Published(string repository)
    {
        var file = Path.Combine(_root, "published.json");
        var panel = new PublishedPanel(
            "master", "origin/master", "4189d1f", "1.0.0", Built, repository, @"C:\panel\app", 5080, "agents-kit-web panel");
        File.WriteAllText(file, JsonSerializer.Serialize(panel, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }));
        return file;
    }

    private WebApplicationFactory<Program> Factory(string publishedFile, string logFile) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", publishedFile),
                    new("PanelFile", Path.Combine(_root, "panel", "panel.json")),
                    new("UpdateLogFile", logFile),
                ]);
            }));

    public void Dispose() => Directory.Delete(_root, recursive: true);
}
