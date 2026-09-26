using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using AgentsKitWeb.Api.Panel;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Настоящий scripts/deploy.ps1 с настоящим Планировщиком заданий: панель из вывода тестов ставится
/// во временный каталог на свободный порт своей задачей, а каталог держит сам тест, как держали его
/// погашенная панель и антивирус. После постановки на порту должна отвечать панель — новая или прежняя,
/// но не пустое место (B-229). Живая панель не задета: у теста свои каталог, порт и имя задачи.
/// </summary>
public sealed class DeployScriptTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-deploy-").FullName;
    private readonly string _target;
    private readonly int _port = FreePort();
    private readonly string _task = $"akw-test-{Guid.NewGuid():N}";
    private readonly List<FileStream> _holds = [];

    public DeployScriptTests() => _target = Path.Combine(_root, "app");

    [Fact]
    public async Task Deploy_WaitsUntilTheOldDirectoryIsReleased()
    {
        await Install("0.1.0");
        var hold = Hold(_target);
        // Держим дольше, чем идут запуск pwsh и гашение: иначе каталог отпустили бы до первой попытки
        // переноса, и тест не проверил бы ожидания.
        _ = Task.Delay(TimeSpan.FromSeconds(10)).ContinueWith(_ => hold.Dispose());

        var (exitCode, output) = await Deploy(Build("0.2.0"), waitSeconds: 30);

        Assert.True(exitCode == 0, output);
        await AssertRunning("0.2.0", output);
    }

    [Fact]
    public async Task Deploy_WhenTheOldDirectoryStaysHeld_KeepsThePreviousPanel()
    {
        await Install("0.1.0");
        Hold(_target);

        var (exitCode, output) = await Deploy(Build("0.2.0"), waitSeconds: 2);

        Assert.True(exitCode != 0, output);
        await AssertRunning("0.1.0", output);
    }

    [Fact]
    public async Task Deploy_WhenTheNewBuildDoesNotStart_KeepsThePreviousPanel()
    {
        await Install("0.1.0");

        var (exitCode, output) = await Deploy(Build("0.2.0", broken: true), waitSeconds: 30);

        Assert.True(exitCode != 0, output);
        await AssertRunning("0.1.0", output);
    }

    [Fact]
    public async Task Deploy_WhenTheNewBuildCannotBeMovedIn_KeepsThePreviousPanel()
    {
        await Install("0.1.0");
        var source = Build("0.2.0");
        Hold(source);

        // Срок с запасом: прежний каталог после гашения должен успеть отойти, иначе срыв случился бы
        // раньше переноса новой, мимо проверяемого пути.
        var (exitCode, output) = await Deploy(source, waitSeconds: 30);

        Assert.True(exitCode != 0, output);
        await AssertRunning("0.1.0", output);
    }

    [Fact]
    public async Task Deploy_WithHeldLeftoversOfPastUpdates_Succeeds()
    {
        // Остаток сорвавшейся постановки, который ещё держат, ни подмене, ни её исходу не мешает:
        // новая панель встала — постановка удалась, а остаток уберёт следующая.
        await Install("0.1.0");
        var leftover = Directory.CreateDirectory(_target + ".old").FullName;
        Hold(leftover);

        var (exitCode, output) = await Deploy(Build("0.2.0"), waitSeconds: 30);

        Assert.True(exitCode == 0, output);
        await AssertRunning("0.2.0", output);
        Assert.True(Directory.Exists(leftover));
    }

    [Fact]
    public async Task Deploy_AfterADoubleFailure_StartsTheWholePanelSetAsideEarlier()
    {
        // Прошлая постановка сорвалась дважды: сломанную сборку отодвинуть не вышло, и она осталась на месте,
        // а целая панель работала из отложенного каталога. Сорвётся и эта — встать должна та целая.
        Directory.Move(Deployed(Build("0.1.0")), _target + ".old-20200101000000");
        Directory.Move(Deployed(Build("0.1.5", broken: true)), _target);

        var (exitCode, output) = await Deploy(Build("0.2.0", broken: true), waitSeconds: 30);

        Assert.True(exitCode != 0, output);
        await AssertRunning("0.1.0", output);
    }

    private async Task Install(string version)
    {
        var (exitCode, output) = await Deploy(Build(version), waitSeconds: 30);
        Assert.True(exitCode == 0, output);
        await AssertRunning(version, output);
    }

    /// <summary>
    /// Сборка панели — вывод тестов, где рядом лежит AgentsKitWeb.Api.exe, с build.json и настройками,
    /// которые уводят панель от профиля оператора: иначе она читала бы живой список баз и сессии.
    /// Сломанная не поднимается — её настройки не читаются.
    /// </summary>
    private string Build(string version, bool broken = false)
    {
        var build = Path.Combine(_root, $"build-{version}-{Guid.NewGuid():N}");
        Copy(AppContext.BaseDirectory, build);
        MarkWindowless(Path.Combine(build, "AgentsKitWeb.Api.exe"));
        File.WriteAllText(Path.Combine(build, "build.json"), JsonSerializer.Serialize(new
        {
            channel = "dev", sha = "0000000", version, builtAt = DateTimeOffset.UtcNow, releases = "owner/repo",
        }));
        var profile = Path.Combine(_root, "profile");
        File.WriteAllText(Path.Combine(build, "appsettings.json"), broken ? "{" : JsonSerializer.Serialize(new
        {
            BasesFile = Path.Combine(profile, "bases.json"),
            SessionsDir = Path.Combine(profile, "sessions"),
            ProjectsDir = Path.Combine(profile, "projects"),
            ClaudeDir = Path.Combine(profile, "claude"),
            CredentialsFile = Path.Combine(profile, "credentials.json"),
        }));
        return build;
    }

    /// <summary>
    /// Помечает exe программой без консоли, как помечает его сборка выпуска (OutputType=WinExe в build.ps1):
    /// вывод тестов собран консольным, и Планировщик открывал каждой запущенной панели окно терминала (B-254).
    /// Подсистема — два байта необязательного заголовка PE, их же правит SDK для WinExe.
    /// </summary>
    private static void MarkWindowless(string exe)
    {
        const int console = 3, windows = 2;
        using var file = new FileStream(exe, FileMode.Open, FileAccess.ReadWrite);
        using var reader = new BinaryReader(file);
        using var writer = new BinaryWriter(file);
        file.Position = 0x3C;
        // Подпись «PE\0\0», заголовок файла в 20 байт, подсистема — со смещения 68 необязательного заголовка.
        file.Position = reader.ReadInt32() + 4 + 20 + 68;
        Assert.Equal(console, reader.ReadUInt16());
        file.Position -= 2;
        writer.Write((ushort)windows);
    }

    /// <summary>Сборка, какой её оставляет постановка: с published.json рядом с exe.</summary>
    private static string Deployed(string build)
    {
        File.Copy(Path.Combine(build, "build.json"), Path.Combine(build, "published.json"));
        return build;
    }

    private async Task<(int ExitCode, string Output)> Deploy(string source, int waitSeconds)
    {
        // pwsh без окна получает свою консоль с кодировкой OEM, и русский текст провала приходил кракозябрами:
        // вывод переводится в UTF-8 до запуска скрипта, как делает панель со своими скриптами.
        var startInfo = new ProcessStartInfo("pwsh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            ArgumentList =
            {
                "-NoProfile", "-Command",
                "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); " +
                $"& {Quote(Script("deploy.ps1"))} -Source {Quote(source)} -Target {Quote(_target)} " +
                $"-Port {_port} -TaskName {Quote(_task)} -WaitSeconds {waitSeconds}",
            },
        };
        using var process = TestProcess.Start(startInfo);
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3));
        }
        catch (TimeoutException)
        {
            // Оставленный жить скрипт ставил бы панель, пока уборка стирает её каталог.
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            return (-1, "постановка не кончилась за 3 минуты:\n" + await output + await error);
        }
        return (process.ExitCode, await output + await error);
    }

    private static string Quote(string value) => "'" + value.Replace("'", "''") + "'";

    /// <summary>На порту отвечает сборка с этим номером: по нему видно, новая встала или прежняя.</summary>
    private async Task AssertRunning(string version, string output) =>
        Assert.True(await RunningVersion() == version, $"на порту не {version}:\n{output}\n{Listing()}");

    private string Listing() => string.Join('\n', Directory.EnumerateFileSystemEntries(_root)
        .Select(entry => Path.GetFileName(entry) + ": " +
                         (File.Exists(Path.Combine(entry, "published.json")) ? "published.json" : "—")));

    private async Task<string?> RunningVersion()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            try
            {
                var panel = await client.GetFromJsonAsync<PanelResponse>($"http://localhost:{_port}/api/panel");
                return panel?.Published?.Version;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException
                                              && DateTime.UtcNow < deadline)
            {
                await Task.Delay(500);
            }
        }
    }

    /// <summary>Держит каталог открытым файлом, как держит его антивирус: такой каталог Windows не переносит.</summary>
    private FileStream Hold(string directory)
    {
        var hold = new FileStream(Path.Combine(directory, $"hold-{Guid.NewGuid():N}.txt"), FileMode.CreateNew,
            FileAccess.ReadWrite, FileShare.None);
        _holds.Add(hold);
        return hold;
    }

    private static void Copy(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.EnumerateFiles(from))
            File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (var directory in Directory.EnumerateDirectories(from))
            Copy(directory, Path.Combine(to, Path.GetFileName(directory)));
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

    /// <summary>
    /// Задача теста снимается, а его панели гасятся и дожидаются по процессу. Каталог стирается с повтором:
    /// только что вышедшую панель ещё секунды держит Windows и антивирус, а на перегруженной машине
    /// снятие задачи идёт дольше минуты — задача оставалась в Планировщике, а каталог не стирался.
    /// </summary>
    public void Dispose()
    {
        foreach (var hold in _holds)
            hold.Dispose();

        using (var unregister = TestProcess.Start(new ProcessStartInfo("pwsh")
               {
                   ArgumentList =
                   {
                       "-NoProfile", "-Command",
                       $"Stop-ScheduledTask -TaskName '{_task}' -ErrorAction SilentlyContinue; " +
                       $"Unregister-ScheduledTask -TaskName '{_task}' -Confirm:$false -ErrorAction SilentlyContinue",
                   },
               }))
        {
            if (!unregister.WaitForExit(TimeSpan.FromMinutes(3)))
                unregister.Kill();
        }

        TestDirs.Delete(_root, StopPanels);
    }

    private void StopPanels()
    {
        foreach (var process in Process.GetProcessesByName("AgentsKitWeb.Api"))
        {
            using (process)
            {
                string? path;
                try
                {
                    path = process.MainModule?.FileName;
                }
                catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    continue;
                }
                if (path is null || !path.StartsWith(_root, StringComparison.OrdinalIgnoreCase))
                    continue;
                try
                {
                    process.Kill();
                }
                catch (InvalidOperationException)
                {
                    // Уже вышла.
                }
                process.WaitForExit(TimeSpan.FromSeconds(30));
            }
        }
    }
}
