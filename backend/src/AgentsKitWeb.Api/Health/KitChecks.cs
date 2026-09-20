using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace AgentsKitWeb.Api.Health;

/// <summary>Находка сверки кита: severity FAIL или WARN, file — файл базы или «.».</summary>
public sealed record KitFinding(string Severity, string File, string Message);

/// <summary>Состояние связи каталога копии по киту: status из цепочки Get-KitLinkState, base — куда указывает копия.</summary>
public sealed record KitLinkState(string Path, string Status, string? Base);

public sealed record KitCheckResult(IReadOnlyList<KitFinding> Findings, IReadOnlyList<KitLinkState> Links);

public interface IKitChecks
{
    /// <summary>Сверка базы и связь её копий; Error задан — проверка не выполнена.</summary>
    Task<(KitCheckResult? Result, string? Error)> RunAsync(
        string kit, string basePath, IReadOnlyList<string> copies, CancellationToken cancellationToken);
}

/// <summary>
/// Проверки через скрипты самого кита: панель состояние связи и сверки не вычисляет. Функции кита
/// дот-сорсятся в одном pwsh на базу — отдельной команды с выводом в JSON у кита нет.
/// </summary>
public sealed class PwshKitChecks : IKitChecks
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    // Перед сверкой исполнители базы развозятся по копиям скриптом кита: оператор про это не знает
    // и руками ничего не запускает, а сверка потом не показывает недовоз, который сама же и устранила.
    // Отказ довоза глотается: копия с оборванной связью — это находка сверки, она приедет следом.
    // Вывод скрипта гасится целиком: он печатает итог в хост, и эти строки встали бы перед JSON ответа.
    // Сверка зовётся от каждой копии базы: разбор своей памяти кит делает только для той копии,
    // от которой смотрит, а сессия каждой копии видит на старте свою. Совпадающие находки схлопываются.
    // git внутри кита оставляет ненулевой код выхода на каталоге вне репозитория, поэтому exit 0 явно.
    // Ошибку скрипт печатает сам: иначе pwsh с -EncodedCommand отдаёт её в stderr в CLIXML.
    private const string Script = """
        $ErrorActionPreference = 'Stop'
        $PSStyle.OutputRendering = 'PlainText'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        try {
        $in = $env:AKW_KIT_CHECK | ConvertFrom-Json
        . (Join-Path $in.kit 'scripts\base-check.ps1')
        $copies = @($in.copies | Where-Object { $_ })
        $deploy = Join-Path $in.kit 'scripts\agents-deploy.ps1'
        if (Test-Path -LiteralPath $deploy) {
            foreach ($c in $copies) {
                try { & $deploy -Path $c *> $null } catch { }
            }
        }
        $worktrees = if ($copies.Count) { $copies } else { @('') }
        $seen = @{}
        $findings = [Collections.Generic.List[object]]::new()
        foreach ($wt in $worktrees) {
            foreach ($f in @(Get-KitBaseFindings $in.base $wt)) {
                $key = "$($f.severity)`n$($f.file)`n$($f.message)"
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $findings.Add([pscustomobject]@{ severity = "$($f.severity)"; file = "$($f.file)"; message = "$($f.message)" })
            }
        }
        $links = [Collections.Generic.List[object]]::new()
        foreach ($c in $copies) {
            $s = Get-KitLinkState $c
            $links.Add([pscustomobject]@{ path = $c; status = "$($s.status)"; base = $s.base })
        }
        [pscustomobject]@{ findings = $findings.ToArray(); links = $links.ToArray() } | ConvertTo-Json -Depth 4 -Compress
        }
        catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            exit 1
        }
        exit 0
        """;

    public async Task<(KitCheckResult? Result, string? Error)> RunAsync(
        string kit, string basePath, IReadOnlyList<string> copies, CancellationToken cancellationToken)
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
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Encode(Script) })
            startInfo.ArgumentList.Add(arg);
        // Пути идут переменной окружения, а не аргументами: так не нужно экранировать их для PowerShell.
        startInfo.Environment["AKW_KIT_CHECK"] = JsonSerializer.Serialize(new { kit, @base = basePath, copies });

        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return (null, "pwsh не запустился");
        }
        if (process is null)
            return (null, "pwsh не запустился");

        using (process)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            timeout.CancelAfter(Timeout);
            try
            {
                var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
                var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
                await process.WaitForExitAsync(timeout.Token);
                var output = await stdout;
                if (process.ExitCode != 0)
                    return (null, FirstLine(await stderr) ?? $"скрипт кита завершился с кодом {process.ExitCode}");
                return Parse(output);
            }
            catch (OperationCanceledException)
            {
                // Гасится и свой таймаут, и остановка панели: сверка ничего не пишет, прерывать её
                // можно в любой момент, а брошенный pwsh держал бы файлы кита ещё две минуты.
                await KillAsync(process);
                if (cancellationToken.IsCancellationRequested)
                    throw;
                return (null, "проверка кита не уложилась по времени");
            }
        }
    }

    /// <summary>Гасит pwsh со всем, что он запустил, и ждёт, пока он отпустит файлы.</summary>
    private static async Task KillAsync(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(wait.Token);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or OperationCanceledException)
        {
            // Процесс успел завершиться сам или не дался — ждать больше нечего.
        }
    }

    private static (KitCheckResult?, string?) Parse(string output)
    {
        try
        {
            var result = JsonSerializer.Deserialize<KitCheckResult>(output, JsonOptions);
            return result is null
                ? (null, "скрипт кита ничего не вернул")
                : (new KitCheckResult(result.Findings ?? [], result.Links ?? []), null);
        }
        catch (JsonException)
        {
            return (null, "ответ скрипта кита не разобран");
        }
    }

    private static string? FirstLine(string text) =>
        text.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();

    private static string Encode(string script) => Convert.ToBase64String(Encoding.Unicode.GetBytes(script));

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
