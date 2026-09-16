using System.Diagnostics;
using System.Text;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Отказ скрипта кита: Message — его собственный текст, готовый показать оператору.</summary>
public sealed record KitScriptFailure(string Message);

/// <summary>
/// Заведение рабочей копии — скриптом кита worktree-add.ps1, а не своим git: он кладёт копию
/// рядом с основной, называет ветку как копию и не заводит копию от той, у которой разорвана
/// связь с базой, — решение оператора.
/// </summary>
public static class KitWorktreeAdd
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    /// <summary>Каталог скриптов установленного кита; настройка KitScripts переопределяет его в тестах.</summary>
    public static string DefaultScripts => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "skills", "agents-kit", "scripts");

    public static string ScriptFile(string scriptsDir) => Path.Combine(scriptsDir, "worktree-add.ps1");

    // Имя копии и путь уходят скрипту переменными окружения, а не строкой команды: в команде их
    // пришлось бы экранировать.
    private const string Command =
        // Без этого pwsh отдаёт текст ошибки в кодировке консоли Windows, и русские буквы бьются.
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
        "$ErrorActionPreference='Stop'; " +
        "$a=@{Path=$env:AKW_COPY}; if ($env:AKW_NAME) { $a.Name=$env:AKW_NAME }; " +
        "try { & $env:AKW_SCRIPT @a } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";

    /// <summary>Заводит копию от <paramref name="copyPath"/>; null — заведена, иначе отказ с текстом кита.</summary>
    public static async Task<KitScriptFailure?> RunAsync(
        string scriptsDir, string copyPath, string? name, CancellationToken cancellationToken)
    {
        var utf8 = new UTF8Encoding(false);
        var startInfo = new ProcessStartInfo("pwsh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = utf8,
            StandardErrorEncoding = utf8,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск.
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", Command })
            startInfo.ArgumentList.Add(arg);
        startInfo.Environment["AKW_SCRIPT"] = ScriptFile(scriptsDir);
        startInfo.Environment["AKW_COPY"] = copyPath;
        startInfo.Environment["AKW_NAME"] = name ?? "";

        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException)
        {
            return new KitScriptFailure("PowerShell (pwsh) не запустился — без него панель копию не заведёт.");
        }
        if (process is null)
            return new KitScriptFailure("PowerShell (pwsh) не запустился — без него панель копию не заведёт.");

        using (process)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                var error = process.StandardError.ReadToEndAsync(timeout.Token);
                _ = process.StandardOutput.ReadToEndAsync(timeout.Token);
                await process.WaitForExitAsync(timeout.Token);
                if (process.ExitCode == 0)
                    return null;

                var message = (await error).Trim();
                return new KitScriptFailure(message.Length > 0
                    ? message
                    : $"Скрипт кита завершился с кодом {process.ExitCode}, ничего не сказав.");
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                return new KitScriptFailure("Скрипт кита не ответил за две минуты — копия могла остаться недоделанной.");
            }
        }
    }
}
