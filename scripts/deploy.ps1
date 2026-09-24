<#
.SYNOPSIS
Ставит собранную панель: гасит стоящую, подменяет её каталог, заводит автозапуск и запускает.

.DESCRIPTION
Общий конец постановки для publish.ps1, update.ps1 и install.ps1. Source — каталог готовой сборки
с build.json (его кладёт build.ps1); он должен лежать рядом с Target, на том же диске:
подмена — перенос каталога, а между дисками каталог не переносится.

Прежний каталог до пуска новой панели не сносится, а откладывается рядом: сорвалась подмена или новая
панель не ответила — прежняя возвращается на место и запускается, и карточка честно говорит, что панель
осталась прежней. Не вышло вернуть и её на место — она запускается оттуда, куда отложена: после гашения
место панели пустым не остаётся (B-229). WaitSeconds — сколько ждать, пока погашенная панель выйдет
и Windows отпустит её каталог.

Рядом с exe остаётся published.json — build.json и то, куда, на какой порт и какой задачей
панель поставлена: обновление ставит свежую сборку с теми же значениями, а гадать ему не по чему —
рядом может стоять вторая панель.

Панель работает под текущим пользователем: читает тот же bases.json из %APPDATA%.

.EXAMPLE
pwsh -NoProfile -File scripts/deploy.ps1 -Source D:\tmp\panel.new -Target D:\tmp\panel -Port 5099 -TaskName 'akw probe'
#>
param(
    [Parameter(Mandatory)]
    [string]$Source,
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel',
    [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'

# Каталоги переносит .NET, а он считает относительный путь от своего текущего каталога, не от PowerShell.
$Source = [IO.Path]::GetFullPath($Source, (Get-Location).Path)
$Target = [IO.Path]::GetFullPath($Target, (Get-Location).Path)

$ExeName = 'AgentsKitWeb.Api.exe'
$url = "http://localhost:$Port"

$published = [ordered]@{}
(Get-Content (Join-Path $Source 'build.json') -Raw | ConvertFrom-Json).PSObject.Properties |
    ForEach-Object { $published[$_.Name] = $_.Value }
$published.target = $Target
$published.port = $Port
$published.taskName = $TaskName
Set-Content (Join-Path $Source 'published.json') ($published | ConvertTo-Json)

$exe = Join-Path $Target $ExeName
# Имена отложенных каталогов — свои на каждую постановку: остаток прошлой, который ещё держат,
# новой не мешает, а уберётся следующей удачной.
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$previous = "$Target.old-$stamp"
$rejected = "$Target.rejected-$stamp"

# Панель ищется по порту и по пути exe, а не через Get-Process: у выходящего процесса тот не отдаёт Path,
# ожидание выхода пропускалось, и каталог переносили из-под ещё живой панели (B-229). По одному имени
# не ищем — так же зовутся dev-API и вторая панель.
function Find-Panel {
    $name = [IO.Path]::GetFileNameWithoutExtension($ExeName)
    $byPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
        Where-Object ProcessName -eq $name
    $byPath = Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" |
        Where-Object ExecutablePath -eq $exe |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    @($byPort) + @($byPath) | Where-Object { $_ } | Sort-Object Id -Unique
}

function Stop-Panel {
    # Процессы берутся до гашения задачи: погашенный уже не найти ни по порту, ни по пути.
    $running = Find-Panel
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
    }
    foreach ($process in $running) {
        $process | Stop-Process -Force -ErrorAction SilentlyContinue
        if (-not $process.WaitForExit($WaitSeconds * 1000)) {
            throw "Панель (процесс $($process.Id)) не вышла за $WaitSeconds с"
        }
    }
}

# localhost — только петлевые адреса: панель пишет в базы и не должна быть видна из сети.
function Register-Panel($directory) {
    $action = New-ScheduledTaskAction -Execute (Join-Path $directory $ExeName) -WorkingDirectory $directory `
        -Argument "--urls $url --contentRoot `"$directory`""
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description "Панель agents-kit-web на $url" -Force | Out-Null
}

# Погашенный процесс и проверка антивирусом ещё держат файлы каталога, и перенос сразу после гашения
# отказывает — «занято другим процессом» или «отказано в доступе»: переносим с повтором, пока не выйдет срок.
# Переименованием, а не Move-Item: тот на отказе переносит каталог по файлам и бросает его на полпути —
# половина панели в одном каталоге, половина в другом (B-229).
function Move-Directory($from, $to) {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ($true) {
        try {
            [IO.Directory]::Move($from, $to)
            return
        }
        catch {
            if ((Get-Date) -gt $deadline) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

# Вышедшая панель ответа уже не даст: ждать её полминуты незачем.
function Wait-Panel {
    $started = Get-Date
    while ($true) {
        try {
            Invoke-RestMethod "$url/api/ping" | Out-Null
            return
        }
        catch {
            $elapsed = ((Get-Date) - $started).TotalSeconds
            if ($elapsed -gt 30) { throw "Панель не ответила на $url/api/ping за 30 секунд" }
            if ($elapsed -gt 3 -and (Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') {
                throw "Панель вышла, не ответив на $url/api/ping"
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

# Последний рубеж: запустить ту целую панель, что есть, — отложенную прежнюю, если она ещё не на месте,
# иначе то, что на месте.
function Start-Remaining {
    foreach ($directory in $previous, $Target) {
        if ((Test-Path (Join-Path $directory $ExeName)) -and (Test-Path (Join-Path $directory 'published.json'))) {
            Write-Host "Запускаю панель из $directory"
            Register-Panel $directory
            Start-ScheduledTask -TaskName $TaskName
            return
        }
    }
    Write-Host 'Целой панели для запуска не осталось'
}

# Отложенное прошлыми и этой постановкой; кого держат — уберёт следующая.
function Remove-Leftovers {
    $parent = Split-Path $Target -Parent
    $leaf = Split-Path $Target -Leaf
    Get-ChildItem -LiteralPath $parent -Directory |
        Where-Object { $_.Name -like "$leaf.old*" -or $_.Name -like "$leaf.rejected-*" } |
        ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
            catch { Write-Host "Не убран $($_.TargetObject): $($_.Exception.Message)" }
        }
}

$hasPrevious = Test-Path $Target
$swapped = $false
try {
    Stop-Panel
    if ($hasPrevious) { Move-Directory $Target $previous }
    $swapped = $true
    Move-Directory $Source $Target
    Register-Panel $Target
    Start-ScheduledTask -TaskName $TaskName
    Wait-Panel
}
catch {
    $failure = $_
    # Новая сборка не встала — на место возвращается прежняя, и оператор остаётся с работающей панелью.
    if ($hasPrevious) {
        Write-Host "Новая сборка не встала: $($failure.Exception.Message) Возвращаю прежнюю."
        try {
            if ($swapped) {
                Stop-Panel
                if (Test-Path $Target) { Move-Directory $Target $rejected }
                Move-Directory $previous $Target
            }
        }
        catch {
            Write-Host "Прежнюю на место вернуть не вышло: $($_.Exception.Message)"
        }
        Start-Remaining
    }
    throw $failure
}
Remove-Leftovers
Write-Host "Панель запущена: $url ($($published.version))"
