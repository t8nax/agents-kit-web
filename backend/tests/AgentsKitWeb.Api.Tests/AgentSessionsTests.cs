using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class AgentSessionsTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("akw-sessions-").FullName;

    [Fact]
    public void VsCodeIn_LiveSessionOfThatCopy_IsFound()
    {
        Write(@"D:\Projects\app", 100);

        var session = Sessions(alive: _ => true).VsCodeIn(@"D:\Projects\app");

        Assert.Equal(100, session!.Pid);
    }

    [Theory]
    [InlineData(@"D:/Projects/app")]
    [InlineData(@"d:\projects\app")]
    [InlineData(@"D:\Projects\app\")]
    public void VsCodeIn_PathWrittenDifferently_IsStillTheSameCopy(string copy)
    {
        Write(@"D:\Projects\app", 100);

        Assert.NotNull(Sessions(alive: _ => true).VsCodeIn(copy));
    }

    [Fact]
    public void VsCodeIn_SessionOfAnotherCopy_IsNotFound()
    {
        Write(@"D:\Projects\other", 100);

        Assert.Null(Sessions(alive: _ => true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_SessionInTerminal_IsNotFound()
    {
        Write(@"D:\Projects\app", 100, entrypoint: "cli");

        Assert.Null(Sessions(alive: _ => true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_FileLeftFromDeadSession_IsNotFound()
    {
        Write(@"D:\Projects\app", 100);

        Assert.Null(Sessions(alive: _ => false).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_BrokenFileNextToGoodOne_DoesNotHideIt()
    {
        File.WriteAllText(Path.Combine(_dir, "broken.json"), "{\"pid\":");
        File.WriteAllText(Path.Combine(_dir, "empty.json"), "[]");
        Write(@"D:\Projects\app", 100);

        Assert.NotNull(Sessions(alive: _ => true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_NoRegistryDirectory_IsNotFound()
    {
        var sessions = new AgentSessions(Path.Combine(_dir, "nope"), _ => true);

        Assert.Null(sessions.VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_LiveBackgroundSessionOfThatCopy_IsFoundWithItsId()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var session = Sessions(alive: _ => true).BackgroundIn(@"D:\Projects\app");

        Assert.Equal("7339dced", session!.JobId);
    }

    [Fact]
    public void BackgroundIn_SessionInVsCode_IsNotFound()
    {
        Write(@"D:\Projects\app", 200);

        Assert.Null(Sessions(alive: _ => true).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_BackgroundSessionWithoutId_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, jobId: null);

        Assert.Null(Sessions(alive: _ => true).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_FileLeftFromDeadSession_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        Assert.Null(Sessions(alive: _ => false).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_SessionOfAnotherCopy_IsNotFound()
    {
        WriteBackground(@"D:\Projects\other", 200, "7339dced");

        Assert.Null(Sessions(alive: _ => true).BackgroundIn(@"D:\Projects\app"));
    }

    private AgentSessions Sessions(Func<int, bool> alive) => new(_dir, alive);

    private void Write(string cwd, int pid, string entrypoint = "claude-vscode") =>
        File.WriteAllText(
            Path.Combine(_dir, $"{pid}.json"),
            $$"""{"pid":{{pid}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"{{entrypoint}}","status":"waiting"}""");

    private void WriteBackground(string cwd, int pid, string? jobId) =>
        File.WriteAllText(
            Path.Combine(_dir, $"{pid}.json"),
            $$"""
            {"pid":{{pid}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"cli","kind":"bg"{{(jobId is null ? "" : $",\"jobId\":\"{jobId}\"")}}}
            """);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
