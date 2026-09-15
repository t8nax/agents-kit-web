<#
.SYNOPSIS
Публикует панель для постоянной работы и ставит её автозапуск.

.DESCRIPTION
Собирает указанный ref (по умолчанию origin/master) во временном git worktree,
не трогая рабочую копию: фронт — в wwwroot, API — dotnet publish. Затем
останавливает запущенную панель, подменяет каталог публикации, регистрирует
задачу Планировщика заданий «при входе пользователя» и запускает панель.

Панель работает под текущим пользователем: читает тот же bases.json из %APPDATA%.

.EXAMPLE
pwsh -NoProfile -File scripts/publish.ps1
#>
param(
    [string]$Ref = 'origin/master',
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$TaskName = 'agents-kit-web panel'
$ExeName = 'AgentsKitWeb.Api.exe'
$repo = Split-Path $PSScriptRoot -Parent
$url = "http://localhost:$Port"

git -C $repo fetch origin
$sha = git -C $repo rev-parse --verify "$Ref^{commit}"
Write-Host "Публикация $Ref ($sha) в $Target"

$work = Join-Path ([IO.Path]::GetTempPath()) "akw-publish-$sha"
# Сборка кладётся рядом с каталогом публикации, чтобы подмена была переносом в пределах одного диска.
$staging = "$Target.new"

try {
    if (Test-Path $work) { git -C $repo worktree remove --force $work }
    git -C $repo worktree add --detach $work $sha

    Push-Location (Join-Path $work 'frontend')
    try {
        npm ci
        npm run build
    }
    finally {
        Pop-Location
    }

    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    # WinExe: задача Планировщика не открывает консольное окно при входе.
    dotnet publish (Join-Path $work 'backend\src\AgentsKitWeb.Api') -c Release -o $staging -p:OutputType=WinExe
    Copy-Item (Join-Path $work 'frontend\dist') (Join-Path $staging 'wwwroot') -Recurse
    Set-Content (Join-Path $staging 'published.txt') "$Ref $sha"

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName
    }
    $exe = Join-Path $Target $ExeName
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue |
        Where-Object Path -eq $exe |
        ForEach-Object { $_ | Stop-Process -Force; $_.WaitForExit() }

    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    Move-Item $staging $Target

    # localhost — только петлевые адреса: панель пишет в базы и не должна быть видна из сети.
    $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $Target `
        -Argument "--urls $url --contentRoot `"$Target`""
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description "Панель agents-kit-web на $url" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    $deadline = (Get-Date).AddSeconds(30)
    while ($true) {
        try {
            Invoke-RestMethod "$url/api/ping" | Out-Null
            break
        }
        catch {
            if ((Get-Date) -gt $deadline) { throw "Панель не ответила на $url/api/ping за 30 секунд" }
            Start-Sleep -Milliseconds 500
        }
    }
    Write-Host "Панель запущена: $url ($sha)"
}
finally {
    if (Test-Path $work) { git -C $repo worktree remove --force $work }
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
}
