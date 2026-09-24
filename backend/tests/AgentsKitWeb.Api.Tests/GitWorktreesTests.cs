using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class GitWorktreesTests
{
    /// <summary>
    /// Панель гасится посреди чтения копии — git гасится вместе с ней и отпускает её файлы: брошенный, он держал
    /// файлы копии, и уборка теста, погасившего панель, падала на них (B-142). Повтор — потому что git быстр,
    /// и отмена не каждый раз застаёт его живым.
    /// </summary>
    [Fact]
    public async Task List_Cancelled_LeavesNoGitHoldingTheCopy()
    {
        for (var i = 0; i < 40; i++)
        {
            var root = Directory.CreateTempSubdirectory("akw-git-cancel-").FullName;
            var copy = TestGit.Repository(Path.Combine(root, "app"));
            using var cancel = new CancellationTokenSource();

            var listing = GitWorktrees.ListAsync(copy, cancel.Token);
            await Task.Delay(i * 2);
            cancel.Cancel();
            try
            {
                await listing;
            }
            catch (OperationCanceledException)
            {
            }

            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(root, recursive: true);
        }
    }
}
