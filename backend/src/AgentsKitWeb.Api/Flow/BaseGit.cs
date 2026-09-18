using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Коммит одного файла базы. Error — вывод git, когда коммит не прошёл.</summary>
public sealed record CommitResult(bool Done, string? Error);

/// <summary>Git в базе: коммит одного файла и чтение его состояния.</summary>
public static class BaseGit
{
    // Хук коммита базы может гонять сверку кита — ей нужно время.
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Коммитит только названный файл базы: `git commit -- путь` берёт его через временный индекс — не трогает
    /// то, что соседняя сессия оставила в индексе, а при отказе хука не оставляет в индексе и сам файл.
    /// Файл должен уже быть в истории: flow.md заводит в базе кит.
    /// </summary>
    public static async Task<CommitResult> CommitFileAsync(
        string basePath, string file, string message, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, "commit", "-m", message, "--", file);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>Файл базы изменён и не закоммичен. null — git не ответил.</summary>
    public static async Task<bool?> IsDirtyAsync(string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, "status", "--porcelain", "--", file);
        return run.ExitCode == 0 ? run.Output.Length > 0 : null;
    }

    /// <summary>Короткий sha последнего коммита, менявшего файл базы. null — git не ответил.</summary>
    public static async Task<string?> LastCommitAsync(string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, "log", "-1", "--format=%h", "--", file);
        return run.ExitCode == 0 && run.Output.Length > 0 ? run.Output : null;
    }
}
