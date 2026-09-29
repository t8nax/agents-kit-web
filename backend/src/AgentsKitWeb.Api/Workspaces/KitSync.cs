namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Чем кончилось сведение базы с сервером скриптом кита: Code — код выхода sync.ps1 (0 — сведено или сводить не с чем,
/// 1 — не сведено, 2 — сервер недоступен), -1 — скрипт не запустился или не уложился в срок; Message — слова кита.
/// </summary>
public sealed record KitSyncResult(int Code, string Message)
{
    public bool Done => Code == 0;
}

/// <summary>
/// Сведение общей базы с её сервером — sync.ps1 установленного кита, -Repo Base. Панель зовёт его, когда пишет описание
/// трекера проекта: кит, сохраняя описание, сначала забирает базу, а записав — отдаёт её, и панель делает так же —
/// решение оператора на B-293. Своим git панель с сервером не сводит: забор, отдачу и конфликты ведёт кит.
/// </summary>
public static class KitSync
{
    public const string Pull = "Pull";
    public const string Push = "Push";

    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    public static string ScriptFile(string kit) => Path.Combine(kit, "scripts", "sync.ps1");

    // Путь и действие идут переменными окружения. Кит говорит строками Write-Host, а код выхода — его ответ, а не сбой:
    // команда печатает его последней строкой и сама выходит с нулём.
    private const string Command = """
        $PSStyle.OutputRendering = 'PlainText'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $global:LASTEXITCODE = 0
        try { & $env:AKW_SCRIPT -Path $env:AKW_COPY -Repo Base -Action $env:AKW_ACTION 6>&1 | ForEach-Object { "$_" } }
        catch {
            "$($_.Exception.Message)"
            "AKW_EXIT=1"
            exit 0
        }
        "AKW_EXIT=$LASTEXITCODE"
        exit 0
        """;

    /// <summary>
    /// Сводит базу рабочей копии <paramref name="copy"/> — скрипту кита нужна копия, связанная с базой. Начатое
    /// сведение не рвётся ни отменой запроса, ни сроком: оборванный посреди rebase git оставил бы базу в незаконченном
    /// сведении — по сроку панель только перестаёт его ждать.
    /// </summary>
    public static async Task<KitSyncResult> RunAsync(string script, string copy, string action)
    {
        var environment = new Dictionary<string, string>
        {
            ["AKW_SCRIPT"] = script,
            ["AKW_COPY"] = copy,
            ["AKW_ACTION"] = action,
        };
        var run = await KitScriptRunner.RunAsync(Command, environment, Timeout, CancellationToken.None, killOnTimeout: false);
        return run.Outcome switch
        {
            KitRunOutcome.NotStarted => new KitSyncResult(-1, "PowerShell (pwsh) не запустился — без него базу не свести с сервером"),
            KitRunOutcome.TimedOut => new KitSyncResult(-1, "Скрипт кита сводит базу с сервером дольше двух минут: панель перестала ждать, а сведение доходит само"),
            KitRunOutcome.Refused => new KitSyncResult(-1, run.Error),
            _ => Parse(run.Output),
        };
    }

    /// <summary>Слова кита и код выхода из последней строки «AKW_EXIT=N».</summary>
    public static KitSyncResult Parse(string output)
    {
        var lines = output.ReplaceLineEndings("\n").Split('\n').Select(l => l.TrimEnd()).Where(l => l.Length > 0).ToList();
        var code = -1;
        if (lines.Count > 0 && lines[^1].StartsWith("AKW_EXIT=", StringComparison.Ordinal)
            && int.TryParse(lines[^1]["AKW_EXIT=".Length..], out var parsed))
        {
            code = parsed;
            lines.RemoveAt(lines.Count - 1);
        }
        return new KitSyncResult(code, string.Join("\n", lines));
    }
}
