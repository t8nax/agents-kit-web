using AgentsKitWeb.Api.Tasks;

namespace AgentsKitWeb.Api.Tests;

public sealed class TaskSessionsTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("akw-task-sessions-").FullName;

    [Fact]
    public void SessionIn_CopyWhereThePanelStartedATask_IsItsSession()
    {
        var sessions = Sessions();

        sessions.Remember(@"D:\Projects\app", "7339dced");

        Assert.Equal("7339dced", sessions.SessionIn(@"D:\Projects\app"));
    }

    [Fact]
    public void SessionIn_CopyWithoutAStartedTask_IsNull()
    {
        Sessions().Remember(@"D:\Projects\other", "7339dced");

        Assert.Null(Sessions().SessionIn(@"D:\Projects\app"));
    }

    [Theory]
    [InlineData(@"D:/Projects/app")]
    [InlineData(@"d:\projects\app")]
    [InlineData(@"D:\Projects\app\")]
    public void SessionIn_PathWrittenDifferently_IsStillTheSameCopy(string copy)
    {
        Sessions().Remember(@"D:\Projects\app", "7339dced");

        Assert.Equal("7339dced", Sessions().SessionIn(copy));
    }

    /// <summary>Задача в копии одна, поэтому новый запуск заменяет отметку, а не ложится рядом.</summary>
    [Fact]
    public void Remember_SecondTaskInTheSameCopy_ReplacesTheFirst()
    {
        var sessions = Sessions();

        sessions.Remember(@"D:\Projects\app", "7339dced");
        sessions.Remember(@"D:\Projects\app", "a1b2c3d4");

        Assert.Equal("a1b2c3d4", sessions.SessionIn(@"D:\Projects\app"));
    }

    [Fact]
    public void Remember_TasksInDifferentCopies_AreKeptApart()
    {
        var sessions = Sessions();

        sessions.Remember(@"D:\Projects\app", "7339dced");
        sessions.Remember(@"D:\Projects\other", "a1b2c3d4");

        Assert.Equal("7339dced", sessions.SessionIn(@"D:\Projects\app"));
        Assert.Equal("a1b2c3d4", sessions.SessionIn(@"D:\Projects\other"));
    }

    /// <summary>Сессия переживает панель: отметка лежит в файле, а не в памяти процесса.</summary>
    [Fact]
    public void SessionIn_PanelStartedAnew_StillKnowsTheSession()
    {
        Sessions().Remember(@"D:\Projects\app", "7339dced");

        Assert.Equal("7339dced", Sessions().SessionIn(@"D:\Projects\app"));
    }

    [Fact]
    public void SessionIn_NoFileYet_IsNull()
    {
        Assert.Null(Sessions().SessionIn(@"D:\Projects\app"));
    }

    /// <summary>Испорченный файл гасит переход, но опрос таблицы не роняет.</summary>
    [Fact]
    public void SessionIn_BrokenFile_IsNull()
    {
        File.WriteAllText(File_(), "{\"sessions\":");

        Assert.Null(Sessions().SessionIn(@"D:\Projects\app"));
    }

    [Fact]
    public void FileBeside_SettingsFile_IsItsNeighbour()
    {
        Assert.Equal(
            Path.Combine(_dir, "task-sessions.json"),
            TaskSessions.FileBeside(Path.Combine(_dir, "bases.json")));
    }

    private string File_() => Path.Combine(_dir, "task-sessions.json");

    private TaskSessions Sessions() => new(File_());

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
