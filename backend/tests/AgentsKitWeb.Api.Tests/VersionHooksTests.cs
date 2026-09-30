using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Хуки git из .githooks: в dev не приходит номер выпуска панели, поднятый не по правилу, а в dev и master — номер
/// ниже, чем на сервере. Номер выпуска поднимает первая задача после выкладки в Стабильный; следующие — только
/// если привозят поломку привычного после одних новинок и починок. Слияние в dev несёт фразу оператору.
/// </summary>
public sealed class VersionHooksTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-hooks-").FullName;

    // Каждый отказ называет, какое число за что: сессия, привыкшая к прежней записи, иначе поднимет не то.
    private const string Rule =
        "В version.txt — номер выпуска 0.X.Y: сломано привычное — поднимается второе число, добавлено новое или починено — третье; " +
        "третье после поднятого второго — ноль. Четвёртое число, номер сборки Беты, ставит сборка на GitHub. " +
        "Номер выпуска поднимает первая задача после выкладки в Стабильный, следующие — только если привозят поломку привычного, когда поднято одно третье число.";

    // Слияние в dev несёт фразу оператору — её проверяет свой хук, commit-msg.
    private const string Phrase = "Оператору: правка видна в панели";

    [Fact]
    public void MergeIntoDev_WithoutPhrase_IsRefused()
    {
        var repository = Repository();
        Task(repository, "feat/silent", "0.10.1");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/silent", "-m", "Merge feat/silent");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("нет фразы оператору", errors);
        Assert.Contains("«Оператору: ", errors);
        // Коммита слияния нет: у головы dev один родитель.
        Assert.DoesNotContain(" ", Git(repository, "log", "-1", "--format=%P").Errors.Trim());
    }

    [Fact]
    public void MergeIntoDev_FinishedAfterConflict_WithoutPhrase_IsRefused()
    {
        var repository = Repository();
        Task(repository, "feat/conflict", "0.10.1");
        TestGit.Run(repository, "switch", "feat/conflict");
        Commit(repository, "shared.txt", "из задачи");
        TestGit.Run(repository, "switch", "dev");
        Commit(repository, "shared.txt", "из dev");
        Git(repository, "merge", "--no-ff", "feat/conflict", "-m", "Merge feat/conflict");
        File.WriteAllText(Path.Combine(repository, "shared.txt"), "вместе\n");
        TestGit.Run(repository, "add", "shared.txt");

        var (exitCode, errors) = Git(repository, "commit", "--no-edit");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("нет фразы оператору", errors);
    }

    [Fact]
    public void MergeIntoDev_WithPhraseOnlyInComment_IsRefused()
    {
        // Строки-комментарии git из сообщения вырезает: фраза в них в выпуск не попала бы.
        var repository = Repository();
        Task(repository, "feat/comment", "0.10.1");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/comment", "-m", "Merge feat/comment", "-m", "# " + Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("нет фразы оператору", errors);
    }

    [Fact]
    public void FirstMergeAfterStable_WithoutRaise_IsRefused()
    {
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Task(repository, "feat/forgot", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/forgot", "-m", "Merge feat/forgot", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, в Стабильном последним вышел 0.10.0, после слияния 0.10.0", errors);
        Assert.Contains("поднимается на один шаг: 0.11.0 или 0.10.1", errors);
        Assert.Contains("version.txt", errors);
        Assert.Contains(Rule, errors);
    }

    [Theory]
    [InlineData("0.11.0")] // ломающее
    [InlineData("0.10.1")] // новое или починка
    public void FirstMergeAfterStable_RaisedByOneStep_Passes(string task)
    {
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Task(repository, "feat/raised", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/raised", "-m", "Merge feat/raised", "-m", Phrase);

        Assert.True(exitCode == 0, errors);
        Assert.Equal(task, Read(repository, "version.txt"));
    }

    [Theory]
    [InlineData("0.10.2")] // не на единицу
    [InlineData("0.12.0")]
    [InlineData("0.11.1")] // третье после поднятого второго не ноль
    [InlineData("0.9.5")] // ниже: сравнивается числами, а не строкой
    public void FirstMergeAfterStable_RaisedWrong_IsRefusedWithExplanation(string task)
    {
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Task(repository, "feat/wrong", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/wrong", "-m", "Merge feat/wrong", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains($"после слияния {task}", errors);
        Assert.Contains("0.11.0 или 0.10.1", errors);
        Assert.Contains(Rule, errors);
    }

    [Fact]
    public void MergeWithoutStable_WithoutRaise_IsRefused()
    {
        // Выпусков Стабильного ещё нет — номер выпуска поднимает каждая задача, пока один не выйдет.
        var repository = Repository();
        Task(repository, "feat/forgot", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/forgot", "-m", "Merge feat/forgot", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("выпусков Стабильного ещё нет", errors);
    }

    [Fact]
    public void StableTagOfBeta_IsNotCounted()
    {
        // Выпуск Беты — v<номер>-dev — не выкладка в Стабильный.
        var repository = Repository();
        Stable(repository, "0.9.0.1");
        TestGit.Run(repository, "tag", "v0.10.0.1-dev");
        Task(repository, "feat/next", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/next", "-m", "Merge feat/next", "-m", Phrase);

        Assert.True(exitCode == 0, errors);
    }

    [Theory]
    [InlineData("0.10.1", "0.10.1")] // новое после нового — номер остаётся
    [InlineData("0.10.1", "0.11.0")] // поломка после одних новинок поднимает второе число
    [InlineData("0.11.0", "0.11.0")] // после поднятого второго — остаётся
    public void MergeAfterRaise_KeepingOrRaisingToBreaking_Passes(string dev, string task)
    {
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Commit(repository, "version.txt", dev);
        Task(repository, "feat/next", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/next", "-m", "Merge feat/next", "-m", Phrase);

        Assert.True(exitCode == 0, errors);
    }

    [Theory]
    [InlineData("0.10.1", "0.10.2", "оставить 0.10.1 или, если задача ломает привычное, 0.11.0")]
    [InlineData("0.11.0", "0.11.1", "оставить 0.11.0.")]
    [InlineData("0.11.0", "0.12.0", "оставить 0.11.0.")]
    public void MergeAfterRaise_RaisingAgain_IsRefusedWithExplanation(string dev, string task, string advice)
    {
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Commit(repository, "version.txt", dev);
        Task(repository, "feat/again", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/again", "-m", "Merge feat/again", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains($"в dev уже {dev}, в Стабильном последним вышел 0.10.0, после слияния {task}", errors);
        Assert.Contains(advice, errors);
        Assert.Contains(Rule, errors);
    }

    [Fact]
    public void MergeIntoDev_WithFourPartVersion_IsRefused()
    {
        // Четвёртое число ставит сборка на GitHub, в version.txt его нет.
        var repository = Repository();
        Stable(repository, "0.10.0.3");
        Task(repository, "feat/four", "0.10.1.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/four", "-m", "Merge feat/four", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("«0.10.1.0», а нужен номер выпуска из трёх чисел", errors);
    }

    [Theory]
    [InlineData("0.27.4.0", "0.28.0")]
    [InlineData("0.27.4.0", "0.27.5")]
    public void FirstReleaseNumber_AfterNumberOfEveryMerge_Passes(string dev, string task)
    {
        // До номера выпуска в version.txt лежал номер из четырёх чисел на каждое слияние.
        var repository = Repository();
        Stable(repository, "0.25.1");
        Commit(repository, "version.txt", dev);
        Task(repository, "feat/first", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/first", "-m", "Merge feat/first", "-m", Phrase);

        Assert.True(exitCode == 0, errors);
    }

    [Theory]
    [InlineData("0.27.4")] // не выше
    [InlineData("0.40.0")] // не на шаг
    [InlineData("0.27.6")]
    public void FirstReleaseNumber_NotAStepFromNumberOfEveryMerge_IsRefused(string task)
    {
        var repository = Repository();
        Commit(repository, "version.txt", "0.27.4.0");
        Task(repository, "feat/first", task);

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/first", "-m", "Merge feat/first", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains($"в dev 0.27.4.0, это номер прежней записи, после слияния {task}", errors);
        Assert.Contains("поднимается на один шаг: 0.28.0 или 0.27.5", errors);
    }

    [Fact]
    public void BreakingAfterFirstReleaseNumber_BeforeNewStable_RaisesSecondNumber()
    {
        // В Стабильном ещё выпуск прежней записи: номер выпуска поднят от последнего номера прежней записи в dev,
        // и поломка после одних новинок поднимает второе число, а не упирается в старый Стабильный.
        var repository = Repository();
        Stable(repository, "0.25.1");
        Commit(repository, "version.txt", "0.27.4.0");
        Task(repository, "feat/first", "0.27.5");
        var (firstCode, firstErrors) = Git(repository, "merge", "--no-ff", "feat/first", "-m", "Merge feat/first", "-m", Phrase);
        Assert.True(firstCode == 0, firstErrors);
        Task(repository, "feat/breaking", "0.28.0");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/breaking", "-m", "Merge feat/breaking", "-m", Phrase);

        Assert.True(exitCode == 0, errors);
    }

    [Fact]
    public void MergeIntoDev_WithGarbageVersion_IsRefusedWithExplanation()
    {
        var repository = Repository();
        Task(repository, "feat/typo", "0.1o.1");

        var (exitCode, errors) = Git(repository, "merge", "--no-ff", "feat/typo", "-m", "Merge feat/typo", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("«0.1o.1», а нужен номер выпуска из трёх чисел", errors);
        Assert.Contains(Rule, errors);
    }

    [Fact]
    public void FastForwardMergeIntoDev_WithoutRaise_IsRefused()
    {
        // dev не двигался с тех пор, как от него отрезали задачу: без --no-ff в настройке git сдвинул бы dev
        // вперёд, не создавая коммита слияния, и хуки слияния не позвал бы вовсе.
        var repository = Repository();
        Task(repository, "feat/forgot", "0.10.0");

        var (exitCode, errors) = Git(repository, "merge", "feat/forgot", "-m", "Merge feat/forgot", "-m", Phrase);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, выпусков Стабильного ещё нет, после слияния 0.10.0", errors);
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
        Git(repository, "merge", "--no-ff", "feat/conflict", "-m", "Merge feat/conflict", "-m", Phrase);
        File.WriteAllText(Path.Combine(repository, "shared.txt"), "вместе\n");
        TestGit.Run(repository, "add", "shared.txt");

        var (exitCode, errors) = Git(repository, "commit", "--no-edit");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("в dev 0.10.0, выпусков Стабильного ещё нет, после слияния 0.10.0", errors);
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
    public void PushOfChannel_WithSameReleaseNumber_Passes(string channel)
    {
        // Беты одного выпуска идут с одним номером в version.txt: четвёртое число ставит сборка.
        var repository = Pushed(channel);
        Commit(repository, "fix.txt", "починка");

        var (exitCode, errors) = Git(repository, "push", "origin", channel);

        Assert.True(exitCode == 0, errors);
    }

    [Theory]
    [InlineData("dev")]
    [InlineData("master")]
    public void PushOfChannel_WithLowerVersion_IsRefused(string channel)
    {
        var repository = Pushed(channel);
        Commit(repository, "version.txt", "0.9.5");

        var (exitCode, errors) = Git(repository, "push", "origin", channel);

        Assert.NotEqual(0, exitCode);
        Assert.Contains($"ниже, чем на сервере: в {channel} там 0.10.0, в отправляемом 0.9.5", errors);
        Assert.Contains(Rule, errors);
    }

    [Fact]
    public void PushOfChannel_WithReleaseNumberAfterNumberOfEveryMerge_Passes()
    {
        var repository = Pushed("dev");
        Commit(repository, "version.txt", "0.10.2.1");
        Git(repository, "push", "origin", "dev");
        Commit(repository, "version.txt", "0.11.0");

        var (exitCode, errors) = Git(repository, "push", "origin", "dev");

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

    /// <summary>Выпуск Стабильного: тег v<paramref name="version"/> на нынешнем коммите.</summary>
    private static void Stable(string repository, string version) =>
        TestGit.Run(repository, "tag", "v" + version);
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
        using var process = TestProcess.Start(startInfo);
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
