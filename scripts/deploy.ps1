<#
.SYNOPSIS
Ставит собранную панель: гасит стоящую, подменяет её каталог, заводит автозапуск и запускает.

.DESCRIPTION
Общий конец постановки для publish.ps1, update.ps1 и install.ps1. Source — каталог готовой сборки
с build.json (его кладёт build.ps1); он должен лежать рядом с Target, на том же диске:
подмена — перенос каталога, а между дисками каталог не переносится.

Прежний каталог до пуска новой панели не сносится, а откладывается рядом: сорвалась подмена или новая
панель не ответила — прежняя возвращается на место и запускается, и карточка честно говорит, что панель
осталась прежней.

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
    [string]$TaskName = 'agents-kit-web panel'
)

$ErrorActionPreference = 'Stop'

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
$previous = "$Target.old"

function Stop-Panel {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
    }
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue |
        Where-Object Path -eq $exe |
        ForEach-Object { $_ | Stop-Process -Force; $_.WaitForExit() }
}

# localhost — только петлевые адреса: панель пишет в базы и не должна быть видна из сети.
function Register-Panel {
    $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $Target `
        -Argument "--urls $url --contentRoot `"$Target`""
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description "Панель agents-kit-web на $url" -Force | Out-Null
}

# Погашенный процесс и проверка антивирусом ещё секунды держат файлы каталога, и перенос сразу после
# гашения отказывает «занято другим процессом»: переносим с повтором.
function Move-Directory($from, $to) {
    for ($attempt = 1; ; $attempt++) {
        try {
            Move-Item $from $to
            return
        }
        catch [IO.IOException] {
            if ($attempt -ge 20) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Wait-Panel {
    $deadline = (Get-Date).AddSeconds(30)
    while ($true) {
        try {
            Invoke-RestMethod "$url/api/ping" | Out-Null
            return
        }
        catch {
            if ((Get-Date) -gt $deadline) { throw "Панель не ответила на $url/api/ping за 30 секунд" }
            Start-Sleep -Milliseconds 500
        }
    }
}

Stop-Panel
if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
$hasPrevious = Test-Path $Target
$swapped = $false
try {
    if ($hasPrevious) { Move-Directory $Target $previous }
    $swapped = $true
    Move-Directory $Source $Target
    Register-Panel
    Start-ScheduledTask -TaskName $TaskName
    Wait-Panel
}
catch {
    # Новая сборка не встала — на место возвращается прежняя, и оператор остаётся с работающей панелью.
    if ($hasPrevious) {
        Write-Host "Новая сборка не встала: $($_.Exception.Message) Возвращаю прежнюю."
        if ($swapped) {
            Stop-Panel
            if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
            Move-Directory $previous $Target
            Register-Panel
        }
        Start-ScheduledTask -TaskName $TaskName
    }
    throw
}
if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
Write-Host "Панель запущена: $url ($($published.version))"
