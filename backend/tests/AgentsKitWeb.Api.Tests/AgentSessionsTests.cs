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
    public void BackgroundIn_SessionThePanelStarted_IsFoundWithItsId()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var session = Sessions(live: true).BackgroundIn(@"D:\Projects\app", "7339dced");

        Assert.Equal("7339dced", session!.JobId);
    }

    /// <summary>Сессию, заведённую мимо панели, переход не берёт: что она ведёт задачу, ниоткуда не видно.</summary>
    [Fact]
    public void BackgroundIn_AnotherSessionThanTheStartedOne_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, "outsider");

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app", "7339dced"));
    }

    [Fact]
    public void BackgroundIn_PanelDidNotStartATaskHere_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app", null));
    }

    [Fact]
    public void BackgroundIn_SessionInVsCode_IsNotFound()
    {
        Write(@"D:\Projects\app", 200);

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app", "7339dced"));
    }

    [Fact]
    public void BackgroundIn_FileLeftFromDeadSession_IsNotFound()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        Assert.Null(Sessions(live: false).BackgroundIn(@"D:\Projects\app", "7339dced"));
    }

    [Fact]
    public void BackgroundIn_SessionOfAnotherCopy_IsNotFound()
    {
        WriteBackground(@"D:\Projects\other", 200, "7339dced");

        Assert.Null(Sessions(live: true).BackgroundIn(@"D:\Projects\app", "7339dced"));
    }

    [Fact]
    public void VsCodeIn_WaitingSessionNextToWorkingOne_IsTheOneOperatorIsWaitedFor()
    {
        Write(@"D:\Projects\app", 100, status: "busy");
        Write(@"D:\Projects\app", 101, status: "waiting");

        Assert.Equal(101, Sessions(live: true).VsCodeIn(@"D:\Projects\app")!.Pid);
    }

    /// <summary>Из сессий с одним состоянием старшая — скорее брошенная с прошлого раза.</summary>
    [Fact]
    public void VsCodeIn_TwoSessionsOfTheSameState_IsTheOneStartedLater()
    {
        Write(@"D:\Projects\app", 100, status: "busy", procStart: Started);
        Write(@"D:\Projects\app", 101, status: "busy", procStart: Started + 1);
        var sessions = new AgentSessions(_dir, pid => pid == 101 ? Started + 1 : Started);

        Assert.Equal(101, sessions.VsCodeIn(@"D:\Projects\app")!.Pid);
    }

    [Theory]
    [InlineData("busy", SessionState.Working)]
    [InlineData("waiting", SessionState.Waiting)]
    [InlineData("idle", SessionState.Idle)]
    public void State_SessionOfTheTask_IsItsState(string status, string expected)
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced", status: status);

        Assert.Equal(expected, Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    [Theory]
    [InlineData("tomorrow-status")]
    [InlineData(null)]
    public void State_StatusPanelDoesNotKnow_CountsAsStanding(string? status)
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced", status: status);

        Assert.Equal(SessionState.Idle, Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    /// <summary>Точка у имени копии говорит о сессии задачи, а не о той, что оператор завёл рядом.</summary>
    [Fact]
    public void State_SomeoneElsesSessionNextToTheTaskOne_IsTheTaskOne()
    {
        WriteBackground(@"D:\Projects\app", 200, "outsider", status: "waiting");
        WriteBackground(@"D:\Projects\app", 201, "7339dced", status: "busy");

        Assert.Equal(SessionState.Working, Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    /// <summary>Сессия в копии есть, но задачу ведёт не она: строке показывать нечего.</summary>
    [Fact]
    public void State_OnlySomeoneElsesSessionInTheCopy_IsNull()
    {
        WriteBackground(@"D:\Projects\app", 200, "outsider", status: "busy");

        Assert.Null(Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    [Fact]
    public void State_TaskSessionOfAnotherCopy_IsNull()
    {
        WriteBackground(@"D:\Projects\other", 200, "7339dced", status: "busy");

        Assert.Null(Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    [Fact]
    public void State_FileLeftFromDeadSession_IsNull()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced", status: "busy");

        Assert.Null(Sessions(live: false).Annotate([Row(@"D:\Projects\app")], _ => "7339dced")[0].SessionState);
    }

    [Fact]
    public void State_PidTakenByAnotherProgram_IsNull()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced", status: "busy");

        // Процесс с этим номером идёт, но стартовал не тогда, когда записано в файле, — это чужая программа.
        var sessions = new AgentSessions(_dir, _ => Started + 1);

        Assert.Null(sessions.Annotate([Row(@"D:\Projects\app")], _ => "7339dced")[0].SessionState);
    }

    [Fact]
    public void State_FileWithoutProcessStart_IsJudgedByPidAlone()
    {
        File.WriteAllText(
            Path.Combine(_dir, "200.json"),
            """{"pid":200,"cwd":"D:\\Projects\\app","entrypoint":"cli","kind":"bg","jobId":"7339dced","status":"busy"}""");

        Assert.Equal(SessionState.Working, Annotated(@"D:\Projects\app", "7339dced")[0].SessionState);
    }

    [Fact]
    public void Annotate_RowOfCopyWithTaskSession_CarriesItsState()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced", status: "waiting");

        var annotated = Annotated(@"D:\Projects\app", "7339dced");

        Assert.Equal(SessionState.Waiting, annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowOfCopyWithoutSession_HasNoState()
    {
        var annotated = Annotated(@"D:\Projects\app");

        Assert.Null(annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowWithError_IsLeftAlone()
    {
        Write(@"D:\Projects\app", 100, status: "busy");

        var annotated = Sessions(live: true).Annotate(
            [Row(@"D:\Projects\app") with { Error = "Копия не найдена на диске" }], _ => "7339dced");

        Assert.Null(annotated[0].SessionState);
    }

    [Fact]
    public void Annotate_RowOfCopyWithTheStartedSession_IsMarked()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var annotated = Annotated(@"D:\Projects\app", "7339dced");

        Assert.True(annotated[0].BackgroundSession);
    }

    /// <summary>Переход приглушён, пока в копии нет сессии, которую панель тут завела.</summary>
    [Fact]
    public void Annotate_RowOfCopyWithSomeoneElsesSession_IsNotMarked()
    {
        WriteBackground(@"D:\Projects\app", 200, "outsider");

        var annotated = Annotated(@"D:\Projects\app", "7339dced");

        Assert.False(annotated[0].BackgroundSession);
    }

    /// <summary>Ответ оператора лежит в памяти, а прочесть его некому — B-106.</summary>
    [Fact]
    public void Annotate_AnsweredCopyWithoutSessions_IsUnread()
    {
        var annotated = Sessions(live: true).Annotate([AnsweredRow(@"D:\Projects\app")], _ => "7339dced");

        Assert.Equal(WorkspaceStatus.Unread, annotated[0].Status);
    }

    [Fact]
    public void Annotate_AnsweredCopyWithTaskSession_StaysInWork()
    {
        WriteBackground(@"D:\Projects\app", 200, "7339dced");

        var annotated = Sessions(live: true).Annotate([AnsweredRow(@"D:\Projects\app")], _ => "7339dced");

        Assert.Equal(WorkspaceStatus.InWork, annotated[0].Status);
    }

    [Fact]
    public void Annotate_AnsweredCopyWithVsCodeSession_StaysInWorkAndIsMarked()
    {
        Write(@"D:\Projects\app", 100);

        var annotated = Sessions(live: true).Annotate([AnsweredRow(@"D:\Projects\app")], _ => null);

        Assert.Equal(WorkspaceStatus.InWork, annotated[0].Status);
        Assert.True(annotated[0].VsCodeSession);
    }

    /// <summary>Сессию, заведённую руками, оператор читателем ответа не считает — решение на B-106.</summary>
    [Fact]
    public void Annotate_AnsweredCopyWithSomeoneElsesBackgroundSession_IsUnread()
    {
        WriteBackground(@"D:\Projects\app", 200, "outsider");

        var annotated = Sessions(live: true).Annotate([AnsweredRow(@"D:\Projects\app")], _ => "7339dced");

        Assert.Equal(WorkspaceStatus.Unread, annotated[0].Status);
    }

    [Fact]
    public void Annotate_CopyWithoutAnswerAndSessions_StaysInWork()
    {
        var annotated = Sessions(live: true).Annotate(
            [Row(@"D:\Projects\app") with { Status = WorkspaceStatus.InWork }], _ => null);

        Assert.Equal(WorkspaceStatus.InWork, annotated[0].Status);
    }

    [Fact]
    public void Row_AnswerUnread_IsNotSentToTheFront()
    {
        var json = JsonSerializer.Serialize(AnsweredRow(@"D:\Projects\app"), JsonSerializerOptions.Web);

        Assert.DoesNotContain("answerUnread", json);
    }

    private static WorkspaceRow AnsweredRow(string path) =>
        Row(path) with { Status = WorkspaceStatus.InWork, AnswerUnread = true };

    private IReadOnlyList<WorkspaceRow> Annotated(string path, string? started = null) =>
        Sessions(live: true).Annotate([Row(path)], _ => started);

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
