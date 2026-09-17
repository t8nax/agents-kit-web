using System.Diagnostics;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Коммит одного файла базы. Error — вывод git, когда коммит не прошёл.</summary>
public sealed record CommitResult(bool Done, string? Error);

public static class BaseGit
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Коммитит только названный файл базы: `git commit -- путь` берёт его через временный индекс — не трогает
    /// то, что соседняя сессия оставила в индексе, а при отказе хука не оставляет в индексе и сам файл.
    /// Файл должен уже быть в истории: flow.md заводит в базе кит.
    /// </summary>
    public static Task<CommitResult> CommitFileAsync(
        string basePath, string file, string message, CancellationToken cancellationToken) =>
        RunAsync(basePath, cancellationToken, "commit", "-m", message, "--", file);

    private static async Task<CommitResult> RunAsync(string basePath, CancellationToken cancellationToken, params string[] args)
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
            return new CommitResult(false, "git не запустился");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // Хук коммита базы может гонять сверку кита — ей нужно время.
        timeout.CancelAfter(Timeout);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0
                ? new CommitResult(true, null)
                : new CommitResult(false, string.Join("\n", new[] { await error, await output }.Select(t => t.Trim()).Where(t => t.Length > 0)));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return new CommitResult(false, "git не ответил вовремя");
        }
    }
}
