using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record Worktree(string Path, string Branch);

public static class GitWorktrees
{
    /// <summary>
    /// Сколько ждать git по копии; не дождались — строка копии «git не прочитал копию». Прогон тестов даёт
    /// запас: на перегруженной машине git не укладывался, и тесты краснели без поломки (B-142).
    /// </summary>
    public static TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Основная копия и её worktree; null — git по копии отказал.</summary>
    public static async Task<IReadOnlyList<Worktree>?> ListAsync(string copyPath, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск git.
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "-C", copyPath, "worktree", "list", "--porcelain" })
            startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo);
        if (process is null)
            return null;

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            _ = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0 ? Parse(await output) : null;
        }
        catch (OperationCanceledException)
        {
            // И свой срок, и остановка панели гасят git и ждут его: брошенный, он держал бы файлы копии.
            // Чтение списка ничего не пишет — рвать его можно в любой момент.
            await KillAsync(process);
            if (cancellationToken.IsCancellationRequested)
                throw;
            return null;
        }
    }

    /// <summary>Гасит git со всем, что он запустил, и ждёт, пока он отпустит файлы.</summary>
    private static async Task KillAsync(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(wait.Token);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or OperationCanceledException)
        {
            // Процесс успел завершиться сам или не дался — ждать больше нечего.
        }
    }

    public static IReadOnlyList<Worktree> Parse(string porcelain)
    {
        var result = new List<Worktree>();
        foreach (var block in porcelain.Replace("\r\n", "\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            string? path = null;
            var branch = "отсоединён";
            foreach (var line in block.Split('\n'))
            {
                if (line.StartsWith("worktree "))
                    path = line["worktree ".Length..];
                else if (line.StartsWith("branch "))
                    branch = line["branch ".Length..].Replace("refs/heads/", "");
            }
            if (path is not null)
                result.Add(new Worktree(path, branch));
        }
        return result;
    }
}
