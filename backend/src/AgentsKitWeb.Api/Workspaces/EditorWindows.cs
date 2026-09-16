using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Окно редактора на каталоге копии: поднять открытое или открыть новое.</summary>
public interface IEditorWindows
{
    Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken);

    /// <summary>Открывает окно на каталоге копии; withSession — вместе с новой сессией агента в нём.</summary>
    Task<bool> OpenAsync(string copyPath, bool withSession, CancellationToken cancellationToken);
}

/// <summary>
/// Окна VS Code через его же CLI. `code -r &lt;каталог&gt;` переиспользует окно, уже открытое
/// на этой папке, и выводит его вперёд; новой сессии агента это не запускает — окно поднимается
/// вместе с той, что в нём идёт.
/// </summary>
public sealed class VsCodeWindows : IEditorWindows
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Пауза между запуском окна и ссылкой: ссылку получает активное окно, и окно копии
    /// становится им не мгновенно. Меньше — ссылка уйдёт в прежнее активное окно.
    /// </summary>
    private static readonly TimeSpan WindowSettles = TimeSpan.FromSeconds(4);

    /// <summary>
    /// Расширение Claude Code открывает новую сессию во вкладке окна, получившего эту ссылку.
    /// Каталог в ссылке не передаётся — сессия стартует в папке окна, поэтому окно открывается первым.
    /// </summary>
    private const string NewSessionUrl = "vscode://anthropic.claude-code/open";

    public Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken) =>
        RunAsync(cancellationToken, "-r", copyPath);

    public async Task<bool> OpenAsync(string copyPath, bool withSession, CancellationToken cancellationToken)
    {
        // Окно открытой папки поднимает только -r, а без такого окна он переоткрывает на неё
        // активное — то есть уводит из-под оператора чужое. Здесь окна копии нет: нужно своё.
        if (!await RunAsync(cancellationToken, "-n", copyPath))
            return false;
        if (!withSession)
            return true;

        await Task.Delay(WindowSettles, cancellationToken);
        return await RunAsync(cancellationToken, "--open-url", NewSessionUrl);
    }

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
