using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record Worktree(string Path, string Branch);

public static class GitWorktrees
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    /// <summary>Основная копия и её worktree; null — git по копии отказал.</summary>
    public static async Task<IReadOnlyList<Worktree>?> ListAsync(string copyPath, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
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
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return null;
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
