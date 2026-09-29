using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Workspaces;

public enum KitRunOutcome
{
    /// <summary>Скрипт кита дошёл до конца.</summary>
    Ok,

    /// <summary>Кит отказал: Error — его слова, готовые показать оператору.</summary>
    Refused,
    NotStarted,
    TimedOut,
}

/// <summary>Итог запуска. Rest — у скрипта, которого панель перестала ждать по сроку, не убив: его конец.</summary>
public sealed record KitRun(KitRunOutcome Outcome, string Output, string Error, Task? Rest = null);

/// <summary>
/// Запуск скрипта установленного кита. Общий для всех скриптов, которые панель зовёт: правила запуска
/// у них одни — pwsh без профиля, UTF-8 на обе стороны, отказ текстом, — а команда и её смысл у каждого свои.
/// </summary>
public static class KitScriptRunner
{
    /// <summary>
    /// Запускает <paramref name="command"/> в pwsh, передав скрипту <paramref name="environment"/>.
    /// Рабочий каталог задаётся явно там, где скрипту не всё равно, откуда его позвали. <paramref name="killOnTimeout"/> —
    /// false у скрипта, который пишет в git: по сроку панель перестаёт его ждать, а он доходит сам, — оборванный
    /// посреди rebase, git оставил бы базу в незаконченном сведении (ревью B-293).
    /// </summary>
    public static async Task<KitRun> RunAsync(
        string command,
        IReadOnlyDictionary<string, string> environment,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string? workingDirectory = null,
        bool killOnTimeout = true)
    {
        var startInfo = new ProcessStartInfo("pwsh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск.
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (workingDirectory is not null)
            startInfo.WorkingDirectory = workingDirectory;
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Encode(command) })
            startInfo.ArgumentList.Add(arg);
        foreach (var (name, value) in environment)
            startInfo.Environment[name] = value;

        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return new KitRun(KitRunOutcome.NotStarted, "", "");
        }
        if (process is null)
            return new KitRun(KitRunOutcome.NotStarted, "", "");

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        // Брошенный по сроку скрипт дочитывается до конца: закрытый канал вывода уронил бы pwsh на следующей строке,
        // и сведение, которому панель перестала мешать, всё равно не дошло бы.
        var reads = killOnTimeout ? limit.Token : CancellationToken.None;
        var stdout = process.StandardOutput.ReadToEndAsync(reads);
        var stderr = process.StandardError.ReadToEndAsync(reads);
        try
        {
            await process.WaitForExitAsync(limit.Token);
            var output = await stdout;
            var error = (await stderr).Trim();
            return process.ExitCode == 0
                ? new KitRun(KitRunOutcome.Ok, output, error)
                : new KitRun(
                    KitRunOutcome.Refused,
                    output,
                    error.Length > 0 ? error : $"скрипт кита завершился с кодом {process.ExitCode}");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (killOnTimeout)
            {
                process.Kill(entireProcessTree: true);
                return new KitRun(KitRunOutcome.TimedOut, "", "");
            }
            var owned = process;
            process = null;
            return new KitRun(KitRunOutcome.TimedOut, "", "", DrainAsync(owned, stdout, stderr));
        }
        finally
        {
            process?.Dispose();
        }
    }

    /// <summary>Дожидается скрипта, который панель перестала ждать, дочитывая его вывод, и отпускает процесс.</summary>
    private static async Task DrainAsync(Process process, Task<string> stdout, Task<string> stderr)
    {
        using (process)
        {
            try
            {
                await Task.WhenAll(stdout, stderr, process.WaitForExitAsync());
            }
            catch (Exception e) when (e is IOException or InvalidOperationException)
            {
                // Вывод, которого уже никто не покажет: важно только дождаться конца процесса.
            }
        }
    }

    private static string Encode(string script) => Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
}
