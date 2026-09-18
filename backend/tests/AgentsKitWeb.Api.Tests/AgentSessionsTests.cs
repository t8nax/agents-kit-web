using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class AgentSessionsTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("akw-sessions-").FullName;

    /// <summary>Время старта процесса, которое видит панель, когда процесс идёт.</summary>
    private const long Started = 134341890912115758;

    [Fact]
    public void VsCodeIn_LiveSessionOfThatCopy_IsFound()
    {
        Write(@"D:\Projects\app", 100);

        var session = Sessions(live: true).VsCodeIn(@"D:\Projects\app");

        Assert.Equal(100, session!.Pid);
    }

    [Theory]
    [InlineData(@"D:/Projects/app")]
    [InlineData(@"d:\projects\app")]
    [InlineData(@"D:\Projects\app\")]
    public void VsCodeIn_PathWrittenDifferently_IsStillTheSameCopy(string copy)
    {
        Write(@"D:\Projects\app", 100);

        Assert.NotNull(Sessions(live: true).VsCodeIn(copy));
    }

    [Fact]
    public void VsCodeIn_SessionOfAnotherCopy_IsNotFound()
    {
        Write(@"D:\Projects\other", 100);

        Assert.Null(Sessions(live: true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_SessionInTerminal_IsNotFound()
    {
        Write(@"D:\Projects\app", 100, entrypoint: "cli");

        Assert.Null(Sessions(live: true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_FileLeftFromDeadSession_IsNotFound()
    {
        Write(@"D:\Projects\app", 100);

        Assert.Null(Sessions(live: false).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_BrokenFileNextToGoodOne_DoesNotHideIt()
    {
        File.WriteAllText(Path.Combine(_dir, "broken.json"), "{\"pid\":");
        File.WriteAllText(Path.Combine(_dir, "empty.json"), "[]");
        Write(@"D:\Projects\app", 100);

        Assert.NotNull(Sessions(live: true).VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void VsCodeIn_NoRegistryDirectory_IsNotFound()
    {
        var sessions = new AgentSessions(Path.Combine(_dir, "nope"), _ => Started);

        Assert.Null(sessions.VsCodeIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_LiveBackgroundSessionOfThatCopy_IsFoundWithItsId()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var session = Sessions(live: true).BackgroundIn(@"D:\Projects\app");

        Assert.Equal("7339dced", session!.JobId);
    }

    [Fact]
    public void BackgroundIn_SessionInVsCode_IsNotFound()
    {
        Write(@"D:\Projects\app", 200);

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_BackgroundSessionWithoutId_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, jobId: null);

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_FileLeftFromDeadSession_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        Assert.Null(Sessions(live: false).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_SessionOfAnotherCopy_IsNotFound()
    {
        WriteBackground(@"D:\Projects\other", 200, "7339dced");

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app"));
    }

    [Fact]
    public void BackgroundIn_WaitingSessionNextToWorkingOne_IsTheOneOperatorIsWaitedFor()
    {
        WriteBackground(@"D:\Projects\app", 200, "working0", status: "busy");
        WriteBackground(@"D:\Projects\app", 201, "waiting0", status: "waiting");

        Assert.Equal("waiting0", Sessions(live: true).BackgroundIn(@"D:\Projects\app")!.JobId);
    }

    [Fact]
    public void BackgroundIn_WorkingSessionNextToStandingOne_IsTheWorkingOne()
    {
        WriteBackground(@"D:\Projects\app", 200, "standing", status: "idle");
        WriteBackground(@"D:\Projects\app", 201, "working0", status: "busy");

        Assert.Equal("working0", Sessions(live: true).BackgroundIn(@"D:\Projects\app")!.JobId);
    }

    /// <summary>Из сессий с одним состоянием старшая — скорее брошенная с прошлого раза.</summary>
    [Fact]
    public void BackgroundIn_TwoSessionsOfTheSameState_IsTheOneStartedLater()
    {
        WriteBackground(@"D:\Projects\app", 200, "older000", status: "busy", procStart: Started);
        WriteBackground(@"D:\Projects\app", 201, "younger0", status: "busy", procStart: Started + 1);
        var sessions = new AgentSessions(_dir, pid => pid == 201 ? Started + 1 : Started);

        Assert.Equal("younger0", sessions.BackgroundIn(@"D:\Projects\app")!.JobId);
    }

    /// <summary>Переход и подпись строки говорят об одной сессии, иначе оператор попадает не туда.</summary>
    [Fact]
    public void BackgroundIn_SessionOfTheTransition_IsTheOneThatGaveTheRowItsState()
    {
        WriteBackground(@"D:\Projects\app", 200, "working0", status: "busy");
        WriteBackground(@"D:\Projects\app", 201, "waiting0", status: "waiting");
        var sessions = Sessions(live: true);

        Assert.Equal(sessions.StateIn(@"D:\Projects\app"), sessions.BackgroundIn(@"D:\Projects\app")!.State);
    }

    [Fact]
    public void VsCodeIn_WaitingSessionNextToWorkingOne_IsTheOneOperatorIsWaitedFor()
    {
        Write(@"D:\Projects\app", 100, status: "busy");
        Write(@"D:\Projects\app", 101, status: "waiting");

        Assert.Equal(101, Sessions(live: true).VsCodeIn(@"D:\Projects\app")!.Pid);
    }

    /// <summary>Сессия другого вида состояние строки даёт, а переход в терминал ведёт не к ней.</summary>
    [Fact]
    public void BackgroundIn_WaitingSessionIsInVsCode_IsStillTheBestBackgroundOne()
    {
        Write(@"D:\Projects\app", 100, status: "waiting");
        WriteBackground(@"D:\Projects\app", 200, "working0", status: "busy");

        Assert.Equal("working0", Sessions(live: true).BackgroundIn(@"D:\Projects\app")!.JobId);
    }

    [Theory]
    [InlineData("busy", SessionState.Working)]
    [InlineData("waiting", SessionState.Waiting)]
    [InlineData("idle", SessionState.Idle)]
    public void StateIn_SessionOfThatCopy_IsItsState(string status, string expected)
    {
        Write(@"D:\Projects\app", 100, status: status);

        Assert.Equal(expected, Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Theory]
    [InlineData("tomorrow-status")]
    [InlineData(null)]
    public void StateIn_StatusPanelDoesNotKnow_CountsAsStanding(string? status)
    {
        Write(@"D:\Projects\app", 100, status: status);

        Assert.Equal(SessionState.Idle, Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_WaitingSessionNextToWorkingOne_Wins()
    {
        Write(@"D:\Projects\app", 100, status: "busy");
        Write(@"D:\Projects\app", 101, status: "waiting");

        Assert.Equal(SessionState.Waiting, Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_WorkingSessionNextToStandingOne_Wins()
    {
        Write(@"D:\Projects\app", 100, status: "idle");
        Write(@"D:\Projects\app", 101, status: "busy");

        Assert.Equal(SessionState.Working, Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_NoSessionInThatCopy_IsNull()
    {
        Write(@"D:\Projects\other", 100, status: "busy");

        Assert.Null(Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_FileLeftFromDeadSession_IsNull()
    {
        Write(@"D:\Projects\app", 100, status: "busy");

        Assert.Null(Sessions(live: false).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_PidTakenByAnotherProgram_IsNull()
    {
        Write(@"D:\Projects\app", 100, status: "busy");

        // Процесс с этим номером идёт, но стартовал не тогда, когда записано в файле, — это чужая программа.
        var sessions = new AgentSessions(_dir, _ => Started + 1);

        Assert.Null(sessions.StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void StateIn_FileWithoutProcessStart_IsJudgedByPidAlone()
    {
        File.WriteAllText(
            Path.Combine(_dir, "100.json"),
            """{"pid":100,"cwd":"D:\\Projects\\app","entrypoint":"cli","status":"busy"}""");

        Assert.Equal(SessionState.Working, Sessions(live: true).StateIn(@"D:\Projects\app"));
    }

    [Fact]
    public void Annotate_RowOfCopyWithSession_CarriesItsState()
    {
        Write(@"D:\Projects\app", 100, status: "waiting");

        var annotated = Sessions(live: true).Annotate([Row(@"D:\Projects\app")]);

        Assert.Equal(SessionState.Waiting, annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowOfCopyWithoutSession_HasNoState()
    {
        var annotated = Sessions(live: true).Annotate([Row(@"D:\Projects\app")]);

        Assert.Null(annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowWithError_IsLeftAlone()
    {
        Write(@"D:\Projects\app", 100, status: "busy");

        var annotated = Sessions(live: true).Annotate([Row(@"D:\Projects\app") with { Error = "Копия не найдена на диске" }]);

        Assert.Null(annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowOfCopyWithBackgroundSession_IsMarked()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var annotated = Sessions(live: true).Annotate([Row(@"D:\Projects\app")]);

        Assert.True(annotated[0].BackgroundSession);
    }

    private static WorkspaceRow Row(string path) =>
        new("Проект", @"D:\base", path, "dev", null, null, null, WorkspaceStatus.Free, null);

    private AgentSessions Sessions(bool live) => new(_dir, _ => live ? Started : null);

    private void Write(
        string cwd, int pid, string entrypoint = "claude-vscode", string? status = "waiting", long procStart = Started) =>
        File.WriteAllText(
            Path.Combine(_dir, $"{pid}.json"),
            $$"""
            {"pid":{{pid}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"{{entrypoint}}","procStart":"{{procStart}}"{{(status is null ? "" : $",\"status\":\"{status}\"")}}}
            """);

    private void WriteBackground(
        string cwd, int pid, string? jobId, string? status = null, long procStart = Started) =>
        File.WriteAllText(
            Path.Combine(_dir, $"{pid}.json"),
            $$"""
            {"pid":{{pid}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"cli","kind":"bg","procStart":"{{procStart}}"{{(jobId is null ? "" : $",\"jobId\":\"{jobId}\"")}}{{(status is null ? "" : $",\"status\":\"{status}\"")}}}
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
