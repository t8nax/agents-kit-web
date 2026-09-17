using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Окно редактора на каталоге копии: поднять открытое или открыть новое.</summary>
public interface IEditorWindows
{
    Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken);

    /// <summary>Открывает окно на каталоге копии; сессию агента в нём заводит оператор.</summary>
    Task<bool> OpenAsync(string copyPath, CancellationToken cancellationToken);
}

/// <summary>
/// Окна VS Code через его же CLI. Сессий агента панель не запускает: сессию заводит ссылка
/// `vscode://`, а окно-получателя таких ссылок VS Code выбирает сам — нужное назвать нечем.
/// </summary>
public sealed class VsCodeWindows : IEditorWindows
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken) =>
        RunAsync(cancellationToken, "-r", copyPath);

    // Окно открытой папки поднимает только -r, а без такого окна он переоткрывает на неё активное —
    // то есть уводит из-под оператора чужое вместе с идущей в нём сессией. Здесь окна копии может
    // не быть, поэтому -n: он и создаёт окно, и переиспользует уже открытое на этой папке.
    public Task<bool> OpenAsync(string copyPath, CancellationToken cancellationToken) =>
        RunAsync(cancellationToken, "-n", copyPath);

    private static async Task<bool> RunAsync(CancellationToken cancellationToken, params string[] args)
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
        startInfo.ArgumentList.Add("/c");
        startInfo.ArgumentList.Add("code");
        foreach (var arg in args)
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
