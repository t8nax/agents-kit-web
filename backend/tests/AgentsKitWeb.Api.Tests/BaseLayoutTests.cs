using System.Text.Json;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Tests;

public sealed class BaseLayoutTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-layout-").FullName;

    [Fact]
    public void Read_BaseOfKitFormat_GivesOperatorCopiesAndFolders()
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"), Path.Combine(_root, "app") + "\\", Path.Combine(_root, "x/../lib"));

        var layout = BaseLayout.Read(basePath, out var problem);

        Assert.NotNull(layout);
        Assert.Equal("", problem);
        Assert.Equal(TestLayout.Operator, layout.Operator);
        Assert.Equal([Path.Combine(_root, "app"), Path.Combine(_root, "lib")], layout.Workspaces);
        Assert.Equal(Path.Combine(basePath, "local", "me"), layout.Personal);
        Assert.Equal(Path.Combine(basePath, "people", TestLayout.Operator), layout.OperatorDir);
        Assert.Equal(Path.Combine(basePath, "local", "me", "work"), layout.WorkDir);
        Assert.Equal(Path.Combine(basePath, "local", "me", "work", BaseLayout.Machine()), layout.MemoryDir);
    }

    [Theory]
    [InlineData(BaseLayout.Format - 1, "База прежнего формата — переведите её китом")]
    [InlineData(1, "База прежнего формата — переведите её китом")]
    [InlineData(BaseLayout.Format + 1, "База нового формата, которого панель не знает, — обновите панель")]
    public void Read_OtherFormat_IsNotRead(int format, string expected)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        File.WriteAllText(Path.Combine(basePath, BaseLayout.MarkerFile),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = format }));

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal(expected, problem);
    }

    [Theory]
    // Прежний вид кита: копии в agents-kit.json, формата нет — кит такую базу не опознаёт.
    [InlineData("""{"kit":"agents-kit","workspaces":["C:\\app"]}""")]
    [InlineData("""{"kit":"other","version":4}""")]
    [InlineData("""{"kit":"agents-kit","version":"4"}""")]
    [InlineData("не json")]
    public void Read_MarkerNotOfKit_IsNotRead(string marker)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        File.WriteAllText(Path.Combine(basePath, BaseLayout.MarkerFile), marker);

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal("Не прочитан agents-kit.json базы", problem);
    }

    [Fact]
    public void Read_NoBase_IsNotRead()
    {
        Assert.Null(BaseLayout.Read(Path.Combine(_root, "gone"), out var problem));
        Assert.Equal("Не прочитан agents-kit.json базы", problem);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Tester")]
    [InlineData("b_ignatyev")]
    [InlineData("-tester")]
    public void Read_OperatorNotNamed_IsNotRead(string? name)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        TestLayout.Machine(basePath, name);

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal("На этом компьютере не назван оператор базы — возьмите проект под кит скиллом /onboard", problem);
    }

    [Fact]
    public void Read_NoMachineFile_OperatorIsNotNamed()
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        File.Delete(Path.Combine(basePath, "local", "me.json"));

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.StartsWith("На этом компьютере не назван оператор базы", problem);
    }

    [Fact]
    public void Read_BrokenMachineFile_IsNotRead()
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        File.WriteAllText(Path.Combine(basePath, "local", "me.json"), "[1]");

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal(@"Не прочитан local\me.json базы", problem);
    }

    [Fact]
    public void Read_NoPersonalRepository_IsNotRead()
    {
        var basePath = Path.Combine(_root, "kb");
        TestLayout.Base(basePath);
        foreach (var file in Directory.EnumerateFiles(Path.Combine(basePath, "local", "me", ".git"), "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(Path.Combine(basePath, "local", "me", ".git"), recursive: true);

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal("На этом компьютере нет личного репозитория оператора — возьмите проект под кит скиллом /onboard", problem);
    }

    [Fact]
    // Как у кита: личный репозиторий бывает и worktree — тогда .git у него файл.
    public void Read_PersonalRepositoryWithGitFile_IsRead()
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        var git = Path.Combine(basePath, "local", "me", ".git");
        Directory.Delete(git, recursive: true);
        File.WriteAllText(git, "gitdir: D:/elsewhere/.git/worktrees/me\n");

        Assert.NotNull(BaseLayout.Read(basePath));
    }

    [Theory]
    [InlineData("MERGE_HEAD")]
    [InlineData("rebase-merge/")]
    [InlineData("rebase-apply/")]
    // Метки конфликта в самом agents-kit.json — причина называется конфликтом, а не «не прочитан» (B-275, ревью).
    public void Read_UnfinishedSyncBrokeMarker_IsNamedConflict(string mark)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        Mark(basePath, mark);
        File.WriteAllText(Path.Combine(basePath, BaseLayout.MarkerFile), "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> origin\n");

        Assert.Null(BaseLayout.Read(basePath, out var problem));
        Assert.Equal("Сведение базы с сервером встало на конфликте — сессии агентов не пишут в неё, пока его не разберут", problem);
    }

    [Theory]
    [InlineData("", "rebase-merge/")]
    [InlineData(@"local\me", "MERGE_HEAD")]
    // Метка сведения при целой разметке базу не гасит: она бывает и у бесконфликтного rebase, а о конфликте скажет
    // сверка кита (B-275, ревью круга 2).
    public void Read_UnfinishedSyncWithIntactMarker_IsRead(string repo, string mark)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, "kb"));
        Mark(Path.Combine(basePath, repo), mark);

        Assert.NotNull(BaseLayout.Read(basePath));
    }

    private static void Mark(string repo, string mark)
    {
        var git = Path.Combine(repo, ".git");
        Directory.CreateDirectory(git);
        if (mark.EndsWith('/'))
            Directory.CreateDirectory(Path.Combine(git, mark.TrimEnd('/')));
        else
            File.WriteAllText(Path.Combine(git, mark), "0000000\n");
    }

    [Theory]
    [InlineData(@"D:\Projects\agents-kit-web", "d-projects-agents-kit-web")]
    [InlineData("DESKTOP-V4UUVUJ", "desktop-v4uuvuj")]
    [InlineData(@"C:\Проекты\Моя копия\", "c-проекты-моя-копия")]
    [InlineData("--a__b--", "a-b")]
    public void Slug_IsKitSlug(string text, string expected)
    {
        Assert.Equal(expected, BaseLayout.Slug(text));
    }

    [Fact]
    public void Machine_IsSlugOfComputerName()
    {
        var name = Environment.GetEnvironmentVariable("COMPUTERNAME") ?? Environment.MachineName;

        Assert.Equal(BaseLayout.Slug(name), BaseLayout.Machine());
    }

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        TestDirs.Delete(_root);
    }
}
