using System.Diagnostics;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Коммит одного файла базы. Error — вывод git, когда коммит не прошёл.</summary>
public sealed record CommitResult(bool Done, string? Error);

/// <summary>Git в базе: коммит одного файла и чтение его состояния.</summary>
public static class BaseGit
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Коммитит только названный файл базы: `git commit -- путь` берёт его через временный индекс — не трогает
    /// то, что соседняя сессия оставила в индексе, а при отказе хука не оставляет в индексе и сам файл.
    /// Файл должен уже быть в истории: flow.md заводит в базе кит.
    /// </summary>
    public static async Task<CommitResult> CommitFileAsync(
        string basePath, string file, string message, CancellationToken cancellationToken)
    {
        var run = await RunAsync(basePath, cancellationToken, "commit", "-m", message, "--", file);
        return run.ExitCode == 0 ? new CommitResult(true, null) : new CommitResult(false, run.Output);
    }

    /// <summary>Файл базы изменён и не закоммичен. null — git не ответил.</summary>
    public static async Task<bool?> IsDirtyAsync(string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await RunAsync(basePath, cancellationToken, "status", "--porcelain", "--", file);
        return run.ExitCode == 0 ? run.Output.Length > 0 : null;
    }

    /// <summary>Короткий sha последнего коммита, менявшего файл базы. null — git не ответил.</summary>
    public static async Task<string?> LastCommitAsync(string basePath, string file, CancellationToken cancellationToken)
    {
        var run = await RunAsync(basePath, cancellationToken, "log", "-1", "--format=%h", "--", file);
        return run.ExitCode == 0 && run.Output.Length > 0 ? run.Output : null;
    }

    /// <summary>ExitCode null — git не запустился или не ответил вовремя. Output — stderr и stdout без пустых краёв.</summary>
    private sealed record GitRun(int? ExitCode, string Output);

    private static async Task<GitRun> RunAsync(string basePath, CancellationToken cancellationToken, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Git пишет UTF-8, а по умолчанию вывод читается кодировкой консоли — русский текст хука бьётся.
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск git.
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-C");
        startInfo.ArgumentList.Add(basePath);
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo);
        if (process is null)
            return new GitRun(null, "git не запустился");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // Хук коммита базы может гонять сверку кита — ей нужно время.
        timeout.CancelAfter(Timeout);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return new GitRun(
                process.ExitCode,
                string.Join("\n", new[] { await error, await output }.Select(t => t.Trim()).Where(t => t.Length > 0)));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return new GitRun(null, "git не ответил вовремя");
        }
    }
}
