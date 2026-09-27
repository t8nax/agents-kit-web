using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Перечень задач выпуска: его считает scripts/release-notes.ps1 при сборке на GitHub, а карточка «Панель»
/// показывает его под номером выпуска.
/// </summary>
public sealed class ReleaseNotesTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-notes-").FullName;

    [Fact]
    public void Notes_ListTheTasksSincePreviousReleaseOfTheChannel()
    {
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        Task(repository, "feat/first", "первая задача");
        TestGit.Run(repository, "tag", "v0.10.0-dev");
        Task(repository, "feat/session-link", "переход строки ведёт в сессию задачи");
        Task(repository, "feat/performer-sync", "исполнитель синхронизируется по копиям");

        // Новые первыми, и приставка слияния из заголовка убрана — оператору она не говорит ничего.
        Assert.Equal(
            ["- исполнитель синхронизируется по копиям", "- переход строки ведёт в сессию задачи"],
            Notes(repository, "dev"));
    }

    [Fact]
    public void Notes_OfFirstRelease_ListTheWholeHistory()
    {
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        Task(repository, "feat/first", "первая задача");

        Assert.Equal(["- первая задача", "- init"], Notes(repository, "dev"));
    }

    [Fact]
    public void Notes_CountFromTheTagOfTheirOwnChannel()
    {
        // Выпуск master с тем же номером, что у dev, не сдвигает начало перечня dev.
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        Task(repository, "feat/first", "первая задача");
        TestGit.Run(repository, "tag", "v0.10.0-dev");
        Task(repository, "feat/second", "вторая задача");
        TestGit.Run(repository, "tag", "v0.10.0");

        Assert.Equal(["- вторая задача"], Notes(repository, "dev"));
    }

    [Fact]
    public void Notes_NameTheTasksInsideABatchMerge()
    {
        // В master работа приезжает пачкой «Merge dev into master», а задачи лежат внутри пачки.
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        TestGit.Run(repository, "switch", "-c", "master");
        TestGit.Run(repository, "tag", "v0.10.0");
        TestGit.Run(repository, "switch", "dev");
        Task(repository, "feat/delete-workspace", "копия удаляется из панели");
        Task(repository, "feat/sidebar", "раздел открывается списком");
        TestGit.Run(repository, "switch", "master");
        Git(repository, "merge", "--no-ff", "dev", "-m", "Merge dev into master");

        Assert.Equal(
            ["- раздел открывается списком", "- копия удаляется из панели"],
            Notes(repository, "master"));
    }

    [Fact]
    public void Notes_SkipTheMergeATaskMadeIntoItself()
    {
        // Задача перед мержем подтянула канал к себе: это слияние ничего в канал не привезло.
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        TestGit.Run(repository, "tag", "v0.10.0-dev");
        TestGit.Run(repository, "switch", "-c", "feat/agent-chat");
        Commit(repository, "разговор продолжается", "chat.txt");
        TestGit.Run(repository, "switch", "dev");
        Task(repository, "feat/sidebar", "раздел открывается списком");
        TestGit.Run(repository, "switch", "feat/agent-chat");
        Git(repository, "merge", "--no-ff", "dev", "-m", "Merge dev в feat/agent-chat перед мержем задачи");
        TestGit.Run(repository, "switch", "dev");
        Git(repository, "merge", "--no-ff", "feat/agent-chat", "-m", "Merge feat/agent-chat: разговор продолжается");

        Assert.Equal(
            ["- разговор продолжается", "- раздел открывается списком"],
            Notes(repository, "dev"));
    }

    private static string[] Notes(string repository, string channel)
    {
        var startInfo = new ProcessStartInfo("pwsh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in new[]
                 {
                     "-NoProfile", "-File", Script, "-Channel", channel, "-Repository", repository,
                 })
            startInfo.ArgumentList.Add(argument);
        using var process = TestProcess.Start(startInfo);
        var output = process.StandardOutput.ReadToEnd();
        var errors = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, errors);
        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    /// <summary>Скрипт из репозитория, в котором лежат тесты: прогон идёт из bin, а скрипт — в корне.</summary>
    private static string Script
    {
        get
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            {
                var script = Path.Combine(directory.FullName, "scripts", "release-notes.ps1");
                if (File.Exists(script))
                    return script;
            }
            throw new FileNotFoundException("scripts/release-notes.ps1 не найден выше каталога тестов");
        }
    }

    /// <summary>Задача: своя ветка, правка и слияние в dev заголовком для оператора.</summary>
    private static void Task(string repository, string branch, string title)
    {
        TestGit.Run(repository, "switch", "-c", branch);
        Commit(repository, title, branch.Replace('/', '-') + ".txt");
        TestGit.Run(repository, "switch", "dev");
        Git(repository, "merge", "--no-ff", branch, "-m", $"Merge {branch}: {title}");
    }

    private static void Commit(string repository, string title, string file)
    {
        File.WriteAllText(Path.Combine(repository, file), title + "\n");
        TestGit.Run(repository, "add", file);
        Git(repository, "commit", "-m", title);
    }

    private static void Git(string repository, params string[] args) =>
        TestGit.Run(repository, ["-c", "user.name=t", "-c", "user.email=t@t", .. args]);

    public void Dispose()
    {
        // Файлы объектов git лежат только для чтения, и обычное удаление каталога о них спотыкается.
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_root, recursive: true);
    }
}
