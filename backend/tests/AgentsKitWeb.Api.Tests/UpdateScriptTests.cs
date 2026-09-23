using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Настоящий scripts/update.ps1 против заглушки GitHub: скачивание с отметками хода, срыв на пропавшем
/// архиве и на связи, которая замолчала посреди архива. Постановка подменена заглушкой deploy.ps1 —
/// настоящая гасила бы и заводила панель.
/// </summary>
public sealed class UpdateScriptTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-update-script-").FullName;
    private readonly HttpListener _github = new();
    private readonly string _address;
    private Func<HttpListenerContext, Task> _archive = _ => Task.CompletedTask;

    public UpdateScriptTests()
    {
        var port = FreePort();
        _address = $"http://localhost:{port}";
        _github.Prefixes.Add(_address + "/");
        _github.Start();
        _ = Serve();
    }

    [Fact]
    public async Task Update_DownloadsTheReleaseOfTheChannelAndInstallsIt()
    {
        var archive = Archive("0.10.2");
        _archive = async context =>
        {
            context.Response.ContentLength64 = archive.Length;
            await context.Response.OutputStream.WriteAsync(archive);
            context.Response.Close();
        };

        var log = await Run();

        Assert.Contains("выпуск v0.10.2", log);
        Assert.Contains($"[скачано] {archive.Length} из {archive.Length}", log);
        Assert.Contains("[ставлю]", log);
        Assert.Equal("[конец] готово 0.10.2", log[^1]);
        Assert.True(File.Exists(Path.Combine(_root, "app", "published.json")));
    }

    [Fact]
    public async Task Update_WithoutTheArchive_Fails()
    {
        _archive = context =>
        {
            context.Response.StatusCode = 404;
            context.Response.Close();
            return Task.CompletedTask;
        };

        var log = await Run();

        Assert.DoesNotContain("[ставлю]", log);
        Assert.Equal("[конец] сорвалось", log[^1]);
    }

    [Fact]
    public async Task Update_WhenTheArchiveStopsComing_Fails()
    {
        // Связь не закрылась, а байты перестали идти: без срока на порцию окно обновления висело бы вечно.
        _archive = async context =>
        {
            context.Response.ContentLength64 = 1_000_000;
            await context.Response.OutputStream.WriteAsync(new byte[1000]);
            await context.Response.OutputStream.FlushAsync();
            await Task.Delay(TimeSpan.FromSeconds(30));
        };

        var log = await Run(stallSeconds: 2);

        Assert.Contains(log, line => line.Contains("скачивание встало"));
        Assert.Equal("[конец] сорвалось", log[^1]);
    }

    private async Task<string[]> Run(int stallSeconds = 60)
    {
        var scripts = Directory.CreateDirectory(Path.Combine(_root, "scripts")).FullName;
        File.Copy(Script("update.ps1"), Path.Combine(scripts, "update.ps1"), overwrite: true);
        File.WriteAllText(Path.Combine(scripts, "deploy.ps1"), """
            param($Source, $Target, $Port, $TaskName)
            New-Item -ItemType Directory -Force -Path $Target | Out-Null
            Copy-Item (Join-Path $Source 'build.json') (Join-Path $Target 'published.json')
            """);
        var log = Path.Combine(_root, "update.log");

        var startInfo = new ProcessStartInfo("pwsh") { RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[]
                 {
                     "-NoProfile", "-File", Path.Combine(scripts, "update.ps1"),
                     "-Channel", "master", "-Releases", "owner/repo",
                     "-Target", Path.Combine(_root, "app"), "-Log", log,
                     "-Api", _address, "-Downloads", _address, "-StallSeconds", stallSeconds.ToString(),
                 })
            startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo)!;
        await process.StandardOutput.ReadToEndAsync();
        await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(60));
        return File.ReadAllLines(log, Encoding.UTF8);
    }

    private async Task Serve()
    {
        while (_github.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await _github.GetContextAsync();
            }
            catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
            {
                return;
            }

            var path = context.Request.Url!.AbsolutePath;
            if (path == "/repos/owner/repo/releases")
            {
                var body = Encoding.UTF8.GetBytes("""[{"tag_name":"v0.10.2-dev","body":""},{"tag_name":"v0.10.2","body":"- задача"}]""");
                context.Response.ContentType = "application/json";
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }
            else if (path == "/owner/repo/releases/download/v0.10.2/agents-kit-web-win-x64.zip")
                _ = _archive(context);
            else
            {
                context.Response.StatusCode = 404;
                context.Response.Close();
            }
        }
    }

    /// <summary>Архив выпуска, как его собирает build.ps1: здесь от него нужен только build.json.</summary>
    private static byte[] Archive(string version)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            using var writer = new StreamWriter(zip.CreateEntry("build.json").Open());
            writer.Write($$"""{"channel":"master","version":"{{version}}"}""");
        }
        return memory.ToArray();
    }

    private static int FreePort()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        return ((IPEndPoint)probe.LocalEndpoint).Port;
    }

    /// <summary>Скрипт из репозитория, в котором лежат тесты: прогон идёт из bin, а скрипт — в корне.</summary>
    private static string Script(string name)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var script = Path.Combine(directory.FullName, "scripts", name);
            if (File.Exists(script))
                return script;
        }
        throw new FileNotFoundException($"scripts/{name} не найден выше каталога тестов");
    }

    public void Dispose()
    {
        _github.Stop();
        _github.Close();
        Directory.Delete(_root, recursive: true);
    }
}
