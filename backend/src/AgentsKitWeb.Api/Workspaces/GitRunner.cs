using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>ExitCode null — git не запустился или не ответил вовремя. Output — stderr и stdout без пустых краёв.</summary>
public sealed record GitRun(int? ExitCode, string Output);

/// <summary>
/// Запуск git в чужом репозитории — базы или рабочей копии проекта. Отдельно от того, кто его зовёт:
/// правила запуска у всех одни, а вот команды и их смысл у базы и у копии свои.
/// </summary>
public static class GitRunner
{
    public static async Task<GitRun> RunAsync(
        string workingDirectory, TimeSpan timeout, CancellationToken cancellationToken, params string[] args)
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
        startInfo.ArgumentList.Add(workingDirectory);
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo);
        if (process is null)
            return new GitRun(null, "git не запустился");

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(limit.Token);
            var error = process.StandardError.ReadToEndAsync(limit.Token);
            await process.WaitForExitAsync(limit.Token);
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
