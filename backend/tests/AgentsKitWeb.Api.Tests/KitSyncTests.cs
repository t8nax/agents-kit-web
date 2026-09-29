using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Сведение базы скриптом кита по сроку не рвётся: панель перестаёт ждать, а git доходит сам (ревью B-293).</summary>
public sealed class KitSyncTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-kit-sync-").FullName;

    public void Dispose() => TestDirs.Delete(_root);

    // После срока скрипт ещё пишет в вывод, как sync.ps1 кита между забором и отдачей: закрытый канал уронил бы его.
    private const string Late = """
        Start-Sleep -Seconds 3
        Write-Host 'с remote базы забрано коммитов: 1'
        1..20000 | ForEach-Object { "строка вывода $_ — длиннее буфера канала" }
        Set-Content -LiteralPath $env:AKW_FILE -Value 'дошёл' -Encoding utf8
        """;

    private static async Task<bool> Appears(string file, TimeSpan within)
    {
        var deadline = DateTime.UtcNow + within;
        while (DateTime.UtcNow < deadline)
        {
            if (File.Exists(file))
                return true;
            await Task.Delay(100);
        }
        return false;
    }

    [Fact]
    public async Task Timeout_WithoutKill_StopsWaitingButScriptFinishes()
    {
        var file = Path.Combine(_root, "done.txt");

        var run = await KitScriptRunner.RunAsync(
            Late, new Dictionary<string, string> { ["AKW_FILE"] = file }, TimeSpan.FromSeconds(1), CancellationToken.None,
            killOnTimeout: false);

        Assert.Equal(KitRunOutcome.TimedOut, run.Outcome);
        Assert.True(await Appears(file, TimeSpan.FromSeconds(30)), "скрипт, который панель перестала ждать, должен дойти сам");
    }

    [Fact]
    public async Task Timeout_WithKill_StopsScript()
    {
        var file = Path.Combine(_root, "done.txt");

        var run = await KitScriptRunner.RunAsync(
            Late, new Dictionary<string, string> { ["AKW_FILE"] = file }, TimeSpan.FromSeconds(1), CancellationToken.None);

        Assert.Equal(KitRunOutcome.TimedOut, run.Outcome);
        Assert.False(await Appears(file, TimeSpan.FromSeconds(6)));
    }

    /// <summary>Пока брошенное по сроку сведение идёт, второе на ту же базу не запускается: оно упёрлось бы в первое.</summary>
    [Fact]
    public async Task Sync_WhilePreviousStillRuns_IsNotStarted()
    {
        var script = Path.Combine(_root, "sync.ps1");
        var log = Path.Combine(_root, "sync.log");
        File.WriteAllText(script, $$"""
            param([string]$Path, [string]$Repo, [string]$Action)
            Add-Content -LiteralPath '{{log}}' -Value "начал $Action" -Encoding utf8
            Start-Sleep -Seconds 3
            Write-Host 'на remote базы отдано коммитов: 1'
            Add-Content -LiteralPath '{{log}}' -Value "кончил $Action" -Encoding utf8
            exit 0
            """);
        var copy = Path.Combine(_root, "copy");

        var first = await KitSync.RunAsync(script, copy, KitSync.Push, TimeSpan.FromSeconds(1));
        var second = await KitSync.RunAsync(script, copy, KitSync.Push, TimeSpan.FromSeconds(1));

        Assert.Equal(-1, first.Code);
        Assert.Contains("дольше", first.Message);
        Assert.Equal(new KitSyncResult(-1, "Прежнее сведение базы с сервером ещё идёт: повторите, когда оно закончится"), second);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline && !(File.Exists(log) && File.ReadAllText(log).Contains("кончил")))
            await Task.Delay(100);
        Assert.Equal(["начал Push", "кончил Push"], File.ReadAllLines(log));

        // Первое дошло — следующее сведение идёт как обычно. Строка журнала опережает выход процесса, поэтому ждётся
        // сам захват: он снимается, когда брошенный скрипт вышел (decisions/tests.md).
        KitSyncResult third;
        while ((third = await KitSync.RunAsync(script, copy, KitSync.Push, TimeSpan.FromSeconds(30)))
               .Message.StartsWith("Прежнее сведение", StringComparison.Ordinal) && DateTime.UtcNow < deadline)
            await Task.Delay(100);
        Assert.Equal(new KitSyncResult(0, "на remote базы отдано коммитов: 1"), third);
    }

    [Theory]
    [InlineData("на remote базы отдано коммитов: 1\nAKW_EXIT=0", 0, "на remote базы отдано коммитов: 1")]
    [InlineData("на remote базы не отдано — git: rejected\r\nAKW_EXIT=1\r\n", 1, "на remote базы не отдано — git: rejected")]
    [InlineData("что-то", -1, "что-то")]
    public void Parse_ReadsCodeFromLastLine(string output, int code, string message) =>
        Assert.Equal(new KitSyncResult(code, message), KitSync.Parse(output));
}
