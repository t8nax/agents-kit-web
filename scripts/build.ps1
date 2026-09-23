<#
.SYNOPSIS
Собирает готовую панель в каталог: её ставят как есть, без инструментов разработчика.

.DESCRIPTION
Фронт — npm ci и сборка, его dist ложится в wwwroot; API — dotnet publish под win-x64 со средой .NET
внутри, чтобы на компьютере пользователя .NET не требовался. Рядом кладутся скрипты постановки
и обновления и build.json — что это за сборка: канал, код, номер, время и репозиторий на GitHub,
в котором панель потом ищет выпуски.

Зовут его сборка выпуска на GitHub и publish.ps1 — одна и та же сборка в обоих случаях.

.EXAMPLE
pwsh -NoProfile -File scripts/build.ps1 -Output D:\tmp\akw-build -Channel dev
#>
param(
    [Parameter(Mandatory)]
    [string]$Output,
    [Parameter(Mandatory)]
    [string]$Channel,
    [string]$Source = (Split-Path $PSScriptRoot -Parent),
    [string]$Ref = '',
    [string]$Releases
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$sha = git -C $Source rev-parse HEAD
if (-not $Releases) {
    # Выпуски лежат там, откуда взят код: owner/repo из адреса origin на GitHub.
    $origin = git -C $Source remote get-url origin
    $Releases = if ($origin -match 'github\.com[:/](.+?/.+?)(\.git)?$') { $Matches[1] } else { 't8nax/agents-kit-web' }
}

Push-Location (Join-Path $Source 'frontend')
try {
    npm ci
    npm run build
}
finally {
    Pop-Location
}

if (Test-Path $Output) { Remove-Item $Output -Recurse -Force }
# WinExe: задача Планировщика не открывает консольное окно при входе.
dotnet publish (Join-Path $Source 'backend\src\AgentsKitWeb.Api') -c Release -o $Output `
    -r win-x64 --self-contained -p:OutputType=WinExe
Copy-Item (Join-Path $Source 'frontend\dist') (Join-Path $Output 'wwwroot') -Recurse

# Обновление идёт этими же скриптами из самой панели: исходников рядом с ней нет.
$scripts = New-Item -ItemType Directory -Path (Join-Path $Output 'scripts')
foreach ($name in 'deploy.ps1', 'update.ps1') {
    Copy-Item (Join-Path $Source "scripts\$name") $scripts
}

$build = [ordered]@{
    channel = $Channel
    ref = $Ref
    sha = $sha
    version = (Get-Content (Join-Path $Source 'version.txt') -Raw).Trim()
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    releases = $Releases
}
Set-Content (Join-Path $Output 'build.json') ($build | ConvertTo-Json)
Write-Host "Собрано: $($build.version) ($sha) в $Output"
