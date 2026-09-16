using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Выводит вперёд окно редактора, открытое на каталоге копии.</summary>
public interface IEditorWindows
{
    Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken);
}

/// <summary>
/// Подъём окна VS Code: `code -r &lt;каталог&gt;` переиспользует окно, уже открытое на этой папке,
/// и выводит его вперёд. Новой сессии агента это не запускает — окно поднимается вместе с той,
/// что в нём идёт.
/// </summary>
public sealed class VsCodeWindows : IEditorWindows
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public async Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken)
    {
        // code — это code.cmd: CreateProcess ищет в PATH только .exe, поэтому запуск идёт через cmd.
        var startInfo = new ProcessStartInfo("cmd.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск.
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "/c", "code", "-r", copyPath })
            startInfo.ArgumentList.Add(arg);

        using var process = Process.Start(startInfo);
        if (process is null)
            return false;

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        try
        {
            _ = process.StandardOutput.ReadToEndAsync(timeout.Token);
            _ = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode == 0;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            process.Kill(entireProcessTree: true);
            return false;
        }
    }
}
