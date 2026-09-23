using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Хуки git из .githooks: в dev и master не приходит код, у которого не вырос номер версии панели, — иначе сборка
/// выпуска на GitHub краснеет на уже вышедшем номере уже после отправки.
/// </summary>
public sealed class VersionHooksTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-hooks-").FullName;

    [Fact]
    public void MergeIntoDev_WithoutNewVersion_IsRefused()
    {
        var repository = Repository();
        Task(repository, "feat/forgot", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/forgot", "-m", "Merge feat/forgot");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, после слияния 0.10.0", errors);
        Assert.Contains("version.txt", errors);
    }

    [Fact]
    public void MergeIntoDev_WithLowerVersion_IsRefused()
    {
        // Строкой «0.9.5» больше «0.10.0»: номер сравнивается числами.
        var repository = Repository();
        Task(repository, "feat/behind", "0.9.5");

        var (exitCode, _) = Git(repository, "merge", "--no-ff", "feat/behind", "-m", "Merge feat/behind");

        Assert.NotEqual(0, exitCode);
    }

    [Fact]
    public void MergeIntoDev_WithNewVersion_Passes()
    {
        var repository = Repository();
        Task(repository, "feat/raised", "0.10.1");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/raised", "-m", "Merge feat/raised");

        Assert.True(exitCode == 0, errors);
        Assert.Equal("0.10.1", Read(repository, "version.txt"));
    }

    [Fact]
    public void FastForwardMergeIntoDev_WithoutNewVersion_IsRefused()
    {
        // dev не двигался с тех пор, как от него отрезали задачу: без --no-ff в настройке git сдвинул бы dev
        // вперёд, не создавая коммита слияния, и хуки слияния не позвал бы вовсе.
        var repository = Repository();
        Task(repository, "feat/forgot", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "feat/forgot", "-m", "Merge feat/forgot");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, после слияния 0.10.0", errors);
    }

    [Fact]
    public void FastForwardOnlySyncOfDev_Passes()
    {
        // Шаг «Мерж» сперва подтягивает dev к серверу через --ff-only: ключ в команде сильнее --no-ff в настройке.
        var repository = Repository();
        TestGit.Run(repository, "switch", "-c", "server-dev");
        Commit(repository, "server.txt", "слито на сервере");
        TestGit.Run(repository, "switch", "dev");

        var (exitCode, errors) = Git(repository, "merge", "--ff-only", "server-dev");

        Assert.True(exitCode == 0, errors);
    }

    [Fact]
    public void MergeIntoTaskBranch_IsNotChecked()
    {
        // Задача подтягивает dev к себе перед мержем — номер при этом не её забота.
        var repository = Repository();
        Task(repository, "feat/task", "0.10.1");
        TestGit.Run(repository, "switch", "-c", "feat/other");
        Commit(repository, "other.txt", "другая правка");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "dev", "-m", "Merge dev into feat/other");

        Assert.True(exitCode == 0, errors);
    }

    [Fact]
    public void MergeIntoDev_FinishedAfterConflict_IsRefused()
    {
        // Слияние с конфликтом git доводит обычным коммитом, и хук слияния тогда не зовётся.
        var repository = Repository();
        TestGit.Run(repository, "switch", "-c", "feat/conflict");
        Commit(repository, "shared.txt", "из задачи");
        TestGit.Run(repository, "switch", "dev");
        Commit(repository, "shared.txt", "из dev");
        Git(repository, "merge", "--no-ff", "feat/conflict", "-m", "Merge feat/conflict");
        File.WriteAllText(Path.Combine(repository, "shared.txt"), "вместе\n");
        TestGit.Run(repository, "add", "shared.txt");

        var (exitCode, errors) = Git(repository, "commit", "--no-edit");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, после слияния 0.10.0", errors);
    }

    [Fact]
    public void OrdinaryCommitOnDev_IsNotCheckedLocally()
    {
        // Прямой коммит в dev ловит отправка, а не каждый коммит.
        var repository = Repository();

        var (exitCode, errors) = Commit(repository, "fix.txt", "быстрая починка");

        Assert.True(exitCode == 0, errors);
    }

    [Theory]
    [InlineData("dev")]
    [InlineData("master")]
    public void PushOfChannel_WithoutNewVersion_IsRefused(string channel)
    {
        // Так ловится и то, что попало в канал мимо слияния, — прямой коммит.
        var repository = Pushed(channel);
        Commit(repository, "fix.txt", "быстрая починка");

        var (exitCode, errors) = Git(repository, "push", "origin", channel);

        Assert.NotEqual(0, exitCode);
        Assert.Contains($"на сервере в {channel} 0.10.0, в отправляемом 0.10.0", errors);
    }

    [Theory]
    [InlineData("dev")]
    [InlineData("master")]
    public void PushOfChannel_WithNewVersion_Passes(string channel)
    {
        var repository = Pushed(channel);
        Commit(repository, "fix.txt", "починка");
        Commit(repository, "version.txt", "0.10.1");

        var (exitCode, errors) = Git(repository, "push", "origin", channel);

        Assert.True(exitCode == 0, errors);
    }

    [Fact]
    public void PushOfTaskBranch_IsNotChecked()
    {
        var repository = Pushed("dev");
        TestGit.Run(repository, "switch", "-c", "feat/task");
        Commit(repository, "task.txt", "правка задачи");
        Git(repository, "push", "origin", "feat/task");
        Commit(repository, "task2.txt", "ещё правка");

        var (exitCode, errors) = Git(repository, "push", "origin", "feat/task");

        Assert.True(exitCode == 0, errors);
    }

    /// <summary>Репозиторий с сервером-заглушкой, куда <paramref name="channel"/> уже отправлен с номером 0.10.0.</summary>
    private string Pushed(string channel)
    {
        var repository = Repository();
        if (channel != "dev")
            TestGit.Run(repository, "switch", "-c", channel);
        var server = Path.Combine(_root, "server.git");
        TestGit.Run(_root, "init", "--bare", server);
        TestGit.Run(repository, "remote", "add", "origin", server);
        // Ветки на сервере ещё нет — сравнивать не с чем, и первая отправка проходит.
        var (exitCode, errors) = Git(repository, "push", "origin", channel);
        Assert.True(exitCode == 0, errors);
        return repository;
    }

    /// <summary>Репозиторий на dev с номером 0.10.0 и настройкой из CLAUDE.md: хуки из .githooks, слияние в dev — коммитом.</summary>
    private string Repository()
    {
        var repository = TestGit.Repository(Path.Combine(_root, "repo"));
        TestGit.Run(repository, "config", "core.hooksPath", Hooks);
        TestGit.Run(repository, "config", "branch.dev.mergeOptions", "--no-ff");
        Commit(repository, "version.txt", "0.10.0");
        return repository;
    }

    /// <summary>Каталог хуков репозитория, в котором лежат тесты: прогон идёт из bin, а хуки — в корне.</summary>
    private static string Hooks
    {
        get
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            {
                var hooks = Path.Combine(directory.FullName, ".githooks");
                if (File.Exists(Path.Combine(hooks, "check-version.ps1")))
                    return hooks.Replace('\\', '/');
            }
            throw new DirectoryNotFoundException(".githooks не найден выше каталога тестов");
        }
    }

    /// <summary>Задача: своя ветка с правкой и номером <paramref name="version"/>; остаётся выкачан dev.</summary>
    private static void Task(string repository, string branch, string version)
    {
        TestGit.Run(repository, "switch", "-c", branch);
        Commit(repository, branch.Replace('/', '-') + ".txt", "правка");
        if (version != Read(repository, "version.txt"))
            Commit(repository, "version.txt", version);
        TestGit.Run(repository, "switch", "dev");
    }

    private static (int ExitCode, string Errors) Commit(string repository, string file, string text)
    {
        File.WriteAllText(Path.Combine(repository, file), text + "\n");
        TestGit.Run(repository, "add", file);
        return Git(repository, "commit", "-m", text);
    }

    private static string Read(string repository, string file) =>
        File.ReadAllText(Path.Combine(repository, file)).Trim();

    /// <summary>git с автором и без провала на ненулевом коде: отказ хука — то, что проверяется.</summary>
    private static (int ExitCode, string Errors) Git(string repository, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = repository,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in (string[])["-c", "user.name=t", "-c", "user.email=t@t", .. args])
            startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, errors + output.Result);
    }

    public void Dispose()
    {
        // Файлы объектов git лежат только для чтения, и обычное удаление каталога о них спотыкается.
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_root, recursive: true);
    }
}
