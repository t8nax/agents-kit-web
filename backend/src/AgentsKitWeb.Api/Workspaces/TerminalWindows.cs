using System.ComponentModel;
using System.Diagnostics;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Окно терминала, подключённое к фоновой сессии копии.</summary>
public interface ITerminalWindows
{
    Task<bool> AttachAsync(string copyPath, string sessionId, CancellationToken cancellationToken);
}

/// <summary>
/// Окно PowerShell с «claude attach» — выбор оператора. Сначала пробуется Windows Terminal: у него вкладки
/// и тема оператора; его на машине может не быть, и тогда окно открывает сам pwsh. Окно здесь нужно, поэтому
/// CreateNoWindow остальных запусков панели (decisions/base-access.md) на терминал не распространяется.
/// </summary>
public sealed class WindowsTerminals : ITerminalWindows
{
    /// <summary>
    /// Столько ждут неудачи: окно открылось — процесс терминала живёт, пока в нём сидит оператор,
    /// а упавший запуск завершается сразу. Дольше ждать нечего — оператор ждёт окна.
    /// </summary>
    private static readonly TimeSpan Failure = TimeSpan.FromSeconds(2);

    public async Task<bool> AttachAsync(string copyPath, string sessionId, CancellationToken cancellationToken) =>
        await RunAsync(WindowsTerminal(copyPath, sessionId), cancellationToken)
        || await RunAsync(PowerShellWindow(copyPath, sessionId), cancellationToken);

    /// <summary>`wt -d &lt;копия&gt; pwsh -NoExit -Command claude attach &lt;id&gt;` — вкладка Windows Terminal на копии.</summary>
    public static ProcessStartInfo WindowsTerminal(string copyPath, string sessionId)
    {
        var startInfo = new ProcessStartInfo("wt.exe") { UseShellExecute = false, WorkingDirectory = copyPath };
        startInfo.ArgumentList.Add("-d");
        startInfo.ArgumentList.Add(copyPath);
        startInfo.ArgumentList.Add("pwsh");
        Attach(startInfo, sessionId);
        return startInfo;
    }

    /// <summary>Окно самого pwsh — когда Windows Terminal на машине нет.</summary>
    public static ProcessStartInfo PowerShellWindow(string copyPath, string sessionId)
    {
        var startInfo = new ProcessStartInfo("pwsh.exe") { UseShellExecute = false, WorkingDirectory = copyPath };
        Attach(startInfo, sessionId);
        return startInfo;
    }

    // -NoExit оставляет окно после выхода из сессии: иначе прощальные строки агента негде прочитать.
    private static void Attach(ProcessStartInfo startInfo, string sessionId)
    {
        startInfo.ArgumentList.Add("-NoExit");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add($"claude attach {sessionId}");
    }

    private static async Task<bool> RunAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken)
    {
        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception exception) when (exception is Win32Exception or FileNotFoundException)
        {
            // Этого терминала на машине нет — не отказ панели, а повод попробовать следующий.
            return false;
        }

        if (process is null)
            return false;

        using (process)
        {
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            wait.CancelAfter(Failure);
            try
            {
                await process.WaitForExitAsync(wait.Token);
                // Windows Terminal передаёт вкладку уже открытому окну и выходит нулём — окно всё равно есть.
                return process.ExitCode == 0;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // Процесс жив — окно открыто и в нём идёт сессия.
                return true;
            }
        }
    }
}
