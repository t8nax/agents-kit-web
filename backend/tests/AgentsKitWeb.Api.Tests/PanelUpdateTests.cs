using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class PanelUpdateTests : IDisposable
{
    private static readonly DateTimeOffset Built = new(2026, 9, 12, 19, 40, 0, TimeSpan.Zero);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-update-").FullName;
    private readonly TestReleases _releases = new();

    [Fact]
    public void Log_IsKeptBesideThePanelDirectory()
    {
        // Каталог панели сносится подменой — журнал внутри него не пережил бы обновление.
        var file = PanelUpdateRunner.FileBeside(@"C:\app\panel\published.json");

        Assert.Equal(@"C:\app\update.log", file);
    }

    [Theory]
    [InlineData("[начало] канал dev, выпуск 1.2.0\n[конец] готово 1.2.0", PanelUpdateStates.Done, "1.2.0")]
    [InlineData("[начало] канал dev, выпуск 1.2.0\nархив не скачался\n[конец] сорвалось", PanelUpdateStates.Failed, null)]
    [InlineData("[начало] канал dev, выпуск 1.2.0\n[скачано] 0 из 100", PanelUpdateStates.Running, null)]
    [InlineData("", PanelUpdateStates.None, null)]
    public async Task Update_TellsWhatTheLogSays(string log, string state, string? version)
    {
        var file = Log(log);
        using var factory = Factory(Published(), file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdateState>("/api/panel/update");

        Assert.Equal(state, update?.State);
        Assert.Equal(version, update?.Version);
    }

    [Fact]
    public async Task Update_Downloading_TellsHowMuchIsDownloaded()
    {
        var file = Log("[начало] канал master, выпуск 0.10.2\nвыпуск v0.10.2\n[скачано] 0 из 19293798\n[скачано] 11744051 из 19293798");
        using var factory = Factory(Published(), file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdateState>("/api/panel/update");

        Assert.Equal(PanelUpdateStates.Running, update?.State);
        Assert.Equal("0.10.2", update?.Release);
        Assert.Equal(11744051, update?.Downloaded);
        Assert.Equal(19293798, update?.Total);
        Assert.False(update?.Installing);
        // Отметки хода — для шагов окна, в журнал оператору они не идут.
        Assert.Equal(["[начало] канал master, выпуск 0.10.2", "выпуск v0.10.2"], update?.Log);
    }

    [Fact]
    public async Task Update_Downloaded_TellsItIsInstalling()
    {
        var file = Log("[начало] канал master, выпуск 0.10.2\n[скачано] 19293798 из 19293798\n[ставлю]");
        using var factory = Factory(Published(), file);

        var update = await factory.CreateClient().GetFromJsonAsync<PanelUpdateState>("/api/panel/update");

        Assert.Equal(PanelUpdateStates.Running, update?.State);
        Assert.True(update?.Installing);
    }

    [Fact]
    public async Task Update_Started_RunsTheScriptOfItsBuild()
    {
        _releases.Channel("master", new PanelRelease("0.10.2", "v0.10.2", []), new PanelRelease("0.10.1", "v0.10.1", []));
        var file = Path.Combine(_root, "update.log");
        using var factory = Factory(Published(), file);

        var response = await factory.CreateClient().PostAsync("/api/panel/update", null);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var finished = await Finished(factory);
        await ScriptExited();
        Assert.Equal(PanelUpdateStates.Done, finished.State);
        Assert.Equal("0.10.2", finished.Release);
        // Скрипт получил самый свежий выпуск канала и то, что панель знает о себе: каталог, порт и задачу.
        Assert.Contains($"выпуск v0.10.2 из {PanelUpdates.DefaultRepository}, канал master", finished.Log);
        Assert.Contains(@"панель C:\panel\app на 5080, задача agents-kit-web panel", finished.Log);
        // И запущен из копии рядом с журналом, а не из каталога панели, — вместе с deploy.ps1.
        Assert.Contains($"из {Path.Combine(_root, "update-scripts")}, рядом deploy.ps1", finished.Log);
    }

    [Fact]
    public async Task Update_WhenGitHubIsSilent_IsNotStarted()
    {
        using var factory = Factory(Published(), Path.Combine(_root, "update.log"));

        var response = await factory.CreateClient().PostAsync("/api/panel/update", null);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.False(File.Exists(Path.Combine(_root, "update.log")));
    }

    [Fact]
    public async Task Update_WhileRunning_IsNotStartedTwice()
    {
        _releases.Channel("master", new PanelRelease("0.10.2", "v0.10.2", []));
        var file = Log("[начало] канал master, выпуск 0.10.2\n[скачано] 0 из 100");
        using var factory = Factory(Published(), file);

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

    /// <summary>
    /// Ждёт выхода процесса обновления: строка «[конец]» в журнале ещё не значит, что pwsh вышел, а пока он жив,
    /// его рабочий каталог занят, и уборка класса не может его снести. Панель процесс не ждёт — он переживает её.
    /// </summary>
    private async Task ScriptExited()
    {
        var pid = int.Parse(File.ReadAllText(Path.Combine(_root, "update.pid")));
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return;
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        using (process)
            await process.WaitForExitAsync(deadline.Token);
    }

    private string Log(string text)
    {
        var file = Path.Combine(_root, "update.log");
        if (text.Length > 0)
            File.WriteAllText(file, text);
        return file;
    }

    /// <summary>Скрипты сборки панели с заглушкой update.ps1 вместо настоящей: та скачала бы и подменила панель.</summary>
    private string Scripts()
    {
        var scripts = Directory.CreateDirectory(Path.Combine(_root, "app", "scripts")).FullName;
        File.WriteAllText(Path.Combine(scripts, "deploy.ps1"), "");
        File.WriteAllText(Path.Combine(scripts, "update.ps1"), """
            param($Channel, $Tag, $Releases, $Target, $Port, $TaskName, $Log)
            Set-Content -LiteralPath (Join-Path (Split-Path $Log) 'update.pid') -Value $PID
            Add-Content -LiteralPath $Log -Value "выпуск $Tag из $Releases, канал $Channel"
            Add-Content -LiteralPath $Log -Value "панель $Target на $Port, задача $TaskName"
            $deploy = if (Test-Path (Join-Path $PSScriptRoot 'deploy.ps1')) { 'deploy.ps1' } else { 'ничего' }
            Add-Content -LiteralPath $Log -Value "из $PSScriptRoot, рядом $deploy"
            Add-Content -LiteralPath $Log -Value '[конец] готово 0.10.2'
            """);
        return scripts;
    }

    private string Published()
    {
        var file = Path.Combine(_root, "published.json");
        var panel = new PublishedPanel(
            "master", "origin/master", "4189d1f", "0.10.0", Built, null, @"C:\panel\app", 5080, "agents-kit-web panel");
        File.WriteAllText(file, JsonSerializer.Serialize(panel, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }));
        return file;
    }

    private WebApplicationFactory<Program> Factory(string publishedFile, string logFile) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("PublishedFile", publishedFile),
                    new("PanelFile", Path.Combine(_root, "panel", "panel.json")),
                    new("UpdateLogFile", logFile),
                    new("UpdateScriptsDir", Scripts()),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IPanelReleases>();
                services.AddSingleton<IPanelReleases>(_releases);
            });
        });

    public void Dispose() => Directory.Delete(_root, recursive: true);
}
