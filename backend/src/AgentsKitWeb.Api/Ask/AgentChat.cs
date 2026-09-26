using System.ComponentModel;
using System.Diagnostics;
using System.Threading.Channels;

namespace AgentsKitWeb.Api.Ask;

public interface IAgentChat
{
    /// <summary>
    /// Держит один процесс агента на весь разговор: реплики уходят ему в stdin по одной, пока канал не закроют,
    /// а строки stdout отдаются по мере прихода. Отмена токена убивает процесс со всем деревом.
    /// </summary>
    Task<AgentExit> RunAsync(
        ProcessStartInfo startInfo,
        ChannelReader<string> replies,
        Func<string, Task> onLine,
        CancellationToken cancellationToken);
}

/// <summary>
/// Разговор идёт одним живым процессом, а не запуском на каждую реплику: так агент помнит сказанное раньше,
/// и сессия при этом не ложится на диск — решение оператора на B-79.
/// </summary>
public sealed class AgentChat : IAgentChat
{
    public async Task<AgentExit> RunAsync(
        ProcessStartInfo startInfo,
        ChannelReader<string> replies,
        Func<string, Task> onLine,
        CancellationToken cancellationToken)
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
            // Процесс вышел сам: реплик он больше не прочтёт, и ждать следующую незачем.
            using var exited = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            try
            {
                var writing = WriteAsync(process, replies, exited.Token);
                var error = process.StandardError.ReadToEndAsync(cancellationToken);
                while (await process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
                    await onLine(line);
                await process.WaitForExitAsync(cancellationToken);
                await exited.CancelAsync();
                await writing;
                return new AgentExit(process.ExitCode, (await error).Trim());
            }
            catch (Exception e) when (e is OperationCanceledException or IOException)
            {
                // Оператор начал новый разговор или панель гасит просьбу: живой процесс дальше не нужен.
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
                throw;
            }
        }
    }

    /// <summary>
    /// Реплика — строка stdin: агент читает их по одной и на каждую отвечает своим итогом. Из канала реплика
    /// уходит, только когда записана: не дошедшую до вышедшего процесса разговор отдаёт новому агенту (B-259).
    /// </summary>
    private static async Task WriteAsync(Process process, ChannelReader<string> replies, CancellationToken cancellationToken)
    {
        try
        {
            while (await replies.WaitToReadAsync(cancellationToken))
            {
                if (!replies.TryPeek(out var reply))
                    continue;
                await process.StandardInput.WriteAsync((reply + "\n").AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
                replies.TryRead(out _);
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException)
        {
            // Процесс уже кончился или разговор отменён: писать больше некому, и чтение stdout скажет об этом само.
            return;
        }

        // Реплик больше не будет: закрытый stdin даёт агенту завершиться самому.
        try
        {
            process.StandardInput.Close();
        }
        catch (IOException)
        {
        }
    }
}
