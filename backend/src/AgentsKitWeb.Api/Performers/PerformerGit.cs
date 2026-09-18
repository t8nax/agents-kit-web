using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Git в рабочей копии проекта: панель кладёт туда файл исполнителя и сама его коммитит, потому что
/// в копии рядом идёт чужая работа — незакоммиченный файл унесла бы в свой коммит соседняя сессия.
/// Все команды названы одним путём: чужого в коммит не попадает.
/// </summary>
public static class PerformerGit
{
    // Хук коммита проекта может гонять свои проверки — им нужно время.
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Кладёт файл в индекс копии. Новый файл в истории не числится, а `commit -- путь` знает только
    /// отслеживаемое, поэтому без add коммит отказал бы с «pathspec did not match».
    /// </summary>
    public static async Task<CommitResult> AddFileAsync(
        string copyPath, string file, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(copyPath, Timeout, cancellationToken, "add", "--", file);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>Коммитит только этот файл: путь в команде — весь коммит.</summary>
    public static async Task<CommitResult> CommitFileAsync(
        string copyPath, string file, string message, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(copyPath, Timeout, cancellationToken, "commit", "-m", message, "--", file);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>
    /// Убирает файл из индекса, когда коммит не прошёл: иначе он остался бы там и уехал бы
    /// в коммит сессии, которая работает в этой копии.
    /// </summary>
    public static async Task UnstageFileAsync(string copyPath, string file, CancellationToken cancellationToken) =>
        await GitRunner.RunAsync(copyPath, Timeout, cancellationToken, "restore", "--staged", "--", file);

    /// <summary>Короткий sha последнего коммита копии — им панель показывает, чем кончилась запись.</summary>
    public static async Task<string?> HeadAsync(string copyPath, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(copyPath, Timeout, cancellationToken, "rev-parse", "--short", "HEAD");
        return run.ExitCode == 0 && run.Output.Length > 0 ? run.Output.Trim() : null;
    }

    /// <summary>
    /// В копии лежит незакоммиченная работа. Сам файл исполнителя не в счёт: его расхождение —
    /// то самое, ради чего синхронизацию и затевают.
    /// </summary>
    public static async Task<bool> DirtyAsync(string copyPath, string performerFile, CancellationToken cancellationToken)
    {
        // Без --untracked-files=all git сворачивает новый каталог в одну строку «?? .claude/», и по ней
        // не видно, что за ней стоит один лишь файл исполнителя.
        var run = await GitRunner.RunAsync(
            copyPath, Timeout, cancellationToken, "status", "--porcelain", "--untracked-files=all");
        if (run.ExitCode != 0)
            return false;
        return run.Output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Length > 3 ? line[3..].Trim().Trim('"') : "")
            .Any(path => path.Length > 0 && !path.Equals(performerFile, StringComparison.OrdinalIgnoreCase));
    }
}
