using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Ask;

/// <summary>Чем кончился процесс агента. ExitCode null — процесс не запустился, Error — почему.</summary>
public sealed record AgentExit(int? ExitCode, string Error);

public interface IAgentProcess
{
    /// <summary>
    /// Запускает процесс, пишет input в его stdin и отдаёт строки stdout по мере прихода.
    /// Отмена токена убивает процесс со всем деревом.
    /// </summary>
    Task<AgentExit> RunAsync(
        ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken);
}

public sealed class AgentProcess : IAgentProcess
{
    public async Task<AgentExit> RunAsync(
        ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
    {
        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Win32Exception e)
        {
            return new AgentExit(null, e.Message);
        }
        if (process is null)
            return new AgentExit(null, "процесс не запустился");

        using (process)
        {
            try
            {
                await process.StandardInput.WriteAsync(input.AsMemory(), cancellationToken);
                process.StandardInput.Close();

                var error = process.StandardError.ReadToEndAsync(cancellationToken);
                while (await process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
                    await onLine(line);
                await process.WaitForExitAsync(cancellationToken);
                return new AgentExit(process.ExitCode, (await error).Trim());
            }
            catch (Exception e) when (e is OperationCanceledException or IOException)
            {
                // Оператор отменил вопрос или закрыл окно: агент не должен работать дальше впустую.
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
                throw;
            }
        }
    }

    /// <summary>Кодировки потоков и окно — общие для любого процесса агента.</summary>
    public static ProcessStartInfo StartInfo(string fileName, string workingDirectory) => new(fileName)
    {
        WorkingDirectory = workingDirectory,
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        StandardInputEncoding = new UTF8Encoding(false),
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
        UseShellExecute = false,
        // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск.
        CreateNoWindow = true,
    };
}
