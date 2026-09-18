<#
.SYNOPSIS
Публикует панель для постоянной работы и ставит её автозапуск.

.DESCRIPTION
Собирает канал (по умолчанию master) во временном git worktree, не трогая рабочую
копию: фронт — в wwwroot, API — dotnet publish. Затем останавливает запущенную
панель, подменяет каталог публикации, регистрирует задачу Планировщика заданий
«при входе пользователя» и запускает панель.

Рядом с exe остаётся published.json: по нему панель знает свою версию, свой канал
и репозиторий, по которому считает вышедшие версии. Панель обновляет себя этим же
скриптом, поэтому он не должен зависеть от того, кто его запустил.

Панель работает под текущим пользователем: читает тот же bases.json из %APPDATA%.

.EXAMPLE
pwsh -NoProfile -File scripts/publish.ps1

.EXAMPLE
pwsh -NoProfile -File scripts/publish.ps1 -Ref feat/some-task -Target D:\tmp\panel -Port 5099 -TaskName 'akw probe'
#>
param(
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    [string]$Ref,
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$ExeName = 'AgentsKitWeb.Api.exe'
$repo = Split-Path $PSScriptRoot -Parent
$url = "http://localhost:$Port"

# Ref задан руками — ставят не канал, а именно его (приёмка ветки задачи), и в published.json
# каналом стоит он сам: иначе панель звала бы веткой задачи чужое имя.
# Отдельная переменная, а не $Channel: ValidateSet проверяет и присваивание.
if ($PSBoundParameters.ContainsKey('Ref')) { $channelName = $Ref }
else {
    $Ref = "origin/$Channel"
    $channelName = $Channel
}

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
    # Панель читает этот файл о самой себе: версия — та, что собрана, репозиторий — тот,
    # в котором она потом считает вышедшие версии и собирает следующее обновление.
    $published = [ordered]@{
        channel = $channelName
        ref = $Ref
        sha = $sha
        version = (Get-Content (Join-Path $work 'version.txt') -Raw).Trim()
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
        repository = $repo
        # Куда, на какой порт и какой задачей поставлена панель: обновление зовёт публикацию
        # с теми же значениями, а гадать ему не по чему — рядом может стоять вторая панель.
        target = $Target
        port = $Port
        taskName = $TaskName
    }
    Set-Content (Join-Path $staging 'published.json') ($published | ConvertTo-Json)

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
