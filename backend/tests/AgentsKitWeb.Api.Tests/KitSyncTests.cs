using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Сведение базы скриптом кита по сроку не рвётся: панель перестаёт ждать, а git доходит сам (ревью B-293).</summary>
public sealed class KitSyncTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-kit-sync-").FullName;

    public void Dispose() => TestDirs.Delete(_root);

    private const string Late = """
        Start-Sleep -Seconds 3
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

    [Theory]
    [InlineData("на remote базы отдано коммитов: 1\nAKW_EXIT=0", 0, "на remote базы отдано коммитов: 1")]
    [InlineData("на remote базы не отдано — git: rejected\r\nAKW_EXIT=1\r\n", 1, "на remote базы не отдано — git: rejected")]
    [InlineData("что-то", -1, "что-то")]
    public void Parse_ReadsCodeFromLastLine(string output, int code, string message) =>
        Assert.Equal(new KitSyncResult(code, message), KitSync.Parse(output));
}
