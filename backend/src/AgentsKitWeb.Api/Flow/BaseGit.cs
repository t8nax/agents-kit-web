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
    /// Файл должен уже быть в истории: scenarios.md заводит в базе кит.
    /// </summary>
    public static Task<CommitResult> CommitFileAsync(
        string basePath, string file, string message, CancellationToken cancellationToken) =>
        CommitFilesAsync(basePath, [file], message, cancellationToken);

    /// <summary>
    /// То же для нескольких файлов сразу: переименованный исполнитель уходит в базу одним коммитом —
    /// новый файл и снятый прежний, — иначе между двумя коммитами база стоит с двумя одинаковыми.
    /// </summary>
    public static async Task<CommitResult> CommitFilesAsync(
        string basePath, IReadOnlyList<string> files, string message, CancellationToken cancellationToken)
    {
        string[] args = ["commit", "-m", message, "--", .. files];
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, args);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>
    /// Кладёт новый файл базы в индекс точечно: `git commit -- путь` сам по себе видит только то,
    /// что git уже отслеживает, и заведённого впервые исполнителя пропустил бы молча.
    /// </summary>
    public static async Task<CommitResult> AddFileAsync(
        string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, "add", "--", file);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>Git уже знает этот файл базы. Нет — коммитить его удаление нечего.</summary>
    public static async Task<bool> TrackedAsync(string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await GitRunner.RunAsync(basePath, Timeout, cancellationToken, "ls-files", "--", file);
        return run.ExitCode == 0 && run.Output.Length > 0;
    }

    /// <summary>
    /// Снимает пути с индекса базы. Зовётся, когда коммит не прошёл: оставленное в индексе заберёт
    /// следующий коммит соседней сессии, и отказанная правка уедет вместе с её работой.
    /// </summary>
    public static async Task ResetFilesAsync(
        string basePath, IReadOnlyList<string> files, CancellationToken cancellationToken)
    {
        string[] args = ["reset", "-q", "--", .. files];
        await GitRunner.RunAsync(basePath, Timeout, cancellationToken, args);
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
