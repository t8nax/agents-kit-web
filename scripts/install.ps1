<#
.SYNOPSIS
Ставит панель на компьютер, где её исходников ещё нет.

.DESCRIPTION
Скрипт для другого компьютера: его скачивают и запускают одной строкой в Windows PowerShell,
поэтому он сам идёт в Windows PowerShell 5.1 и не требует ничего, чего нет на чистой Windows.

Сначала проверяет, есть ли установленный кит и Claude Code со входом в аккаунт: без них
панели работать не с чем, и тогда он говорит, что поставить, и больше ничего не делает.
Затем ставит через winget недостающее для сборки — git, PowerShell 7, .NET SDK 10, Node.js,
клонирует репозиторий панели и зовёт из клона scripts/publish.ps1. Клон остаётся на диске:
по нему поставленная панель потом обновляет себя сама.

Список баз и путь к киту не переносятся: их задают в «Настройках» панели.

.EXAMPLE
iex ((irm https://raw.githubusercontent.com/t8nax/agents-kit-web/master/scripts/install.ps1).TrimStart([char]0xFEFF))

Файл хранится с BOM, иначе Windows PowerShell прочтёт русский текст запуском файлом неверно;
а скачанный строкой, он нёс бы BOM перед param и не разобрался бы — отсюда TrimStart.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Repository D:\tmp\akw-src -Target D:\tmp\akw-app -Port 5099 -TaskName 'akw probe'
#>
param(
    [string]$Repository = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\source'),
    [string]$Source = 'https://github.com/t8nax/agents-kit-web.git',
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    [string]$Ref,
    [string]$Target,
    [int]$Port,
    [string]$TaskName
)

# Всё внутри функции: строкой «irm | iex» скрипт идёт в сессии оператора, и exit закрыл бы ему окно.
function Install-AgentsKitPanel {
    param($Repository, $Source, $Channel, $Ref, $Target, $Port, $TaskName)

    $ErrorActionPreference = 'Stop'

    # Кит — там, где его ищет сама панель: каталог навыков профиля и установленные плагины Claude Code.
    # Признак кита тот же, что у неё: скрипты проверок в scripts\.
    function Find-Kit {
        $claude = Join-Path $env:USERPROFILE '.claude'
        $candidates = @()
        $skills = Join-Path $claude 'skills'
        if (Test-Path $skills) { $candidates += Get-ChildItem $skills -Directory | ForEach-Object FullName }
        $plugins = Join-Path $claude 'plugins\installed_plugins.json'
        if (Test-Path $plugins) {
            try {
                $json = Get-Content $plugins -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($plugin in $json.plugins.PSObject.Properties) {
                    foreach ($install in @($plugin.Value)) { if ($install.installPath) { $candidates += $install.installPath } }
                }
            }
            catch { }
        }
        $candidates | Where-Object {
            (Test-Path (Join-Path $_ 'scripts\base-check.ps1')) -and (Test-Path (Join-Path $_ 'scripts\link-state.ps1'))
        } | Select-Object -First 1
    }

    # Вход в аккаунт — ключ доступа в профиле Claude Code, тот же, по которому панель читает лимиты.
    function Test-ClaudeLogin {
        $file = Join-Path $env:USERPROFILE '.claude\.credentials.json'
        if (-not (Test-Path $file)) { return $false }
        try { return [bool](Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).claudeAiOauth.accessToken }
        catch { return $false }
    }

    function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

    function Test-DotnetSdk {
        if (-not (Test-Command 'dotnet')) { return $false }
        [bool](dotnet --list-sdks | Where-Object { $_ -match '^10\.' })
    }

    # winget меняет PATH в реестре, а не в этом процессе: без перечитывания только что поставленное не видно.
    function Update-Path {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')
    }

    Write-Host 'Проверяю, есть ли то, с чем работает панель…'
    $missing = @()
    $kit = Find-Kit
    if ($kit) { Write-Host "  кит: $kit" }
    else { $missing += 'кит agents-kit — поставьте его для Claude Code по инструкции кита' }
    if (Test-Command 'claude') {
        if (Test-ClaudeLogin) { Write-Host '  Claude Code: есть, вход выполнен' }
        else { $missing += 'вход в аккаунт Claude Code — запустите claude и войдите' }
    }
    else { $missing += 'Claude Code — https://claude.com/claude-code, затем запустите claude и войдите' }

    if ($missing) {
        Write-Host ''
        Write-Host 'Панель не поставлена: на компьютере не хватает того, без чего она не работает.' -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        Write-Host 'Поставьте недостающее и запустите эту же команду снова.'
        return $false
    }

    $tools = @(
        @{ Name = 'git'; Id = 'Git.Git'; Test = { Test-Command 'git' } },
        @{ Name = 'PowerShell 7'; Id = 'Microsoft.PowerShell'; Test = { Test-Command 'pwsh' } },
        @{ Name = '.NET SDK 10'; Id = 'Microsoft.DotNet.SDK.10'; Test = { Test-DotnetSdk } },
        @{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS'; Test = { Test-Command 'npm' } }
    )
    foreach ($tool in $tools) {
        if (& $tool.Test) { continue }
        if (-not (Test-Command 'winget')) {
            Write-Host "Нет $($tool.Name), и поставить его нечем: на компьютере нет winget (App Installer из Microsoft Store)." -ForegroundColor Red
            return $false
        }
        Write-Host "Ставлю $($tool.Name)… Windows может спросить разрешение на установку."
        winget install --id $tool.Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
        Update-Path
        if (-not (& $tool.Test)) {
            Write-Host "$($tool.Name) не поставился — поставьте его руками и запустите команду снова." -ForegroundColor Red
            return $false
        }
    }

    if (Test-Path (Join-Path $Repository '.git')) {
        Write-Host "Исходники уже есть: $Repository"
    }
    elseif ((Test-Path $Repository) -and (Get-ChildItem $Repository -Force | Select-Object -First 1)) {
        Write-Host "В $Repository уже лежит что-то, кроме исходников панели. Укажите другой каталог параметром -Repository." -ForegroundColor Red
        return $false
    }
    else {
        Write-Host "Скачиваю исходники в $Repository…"
        git clone --quiet $Source $Repository
        if ($LASTEXITCODE) {
            Write-Host 'Исходники не скачались.' -ForegroundColor Red
            return $false
        }
    }

    $arguments = @('-NoProfile', '-File', (Join-Path $Repository 'scripts\publish.ps1'), '-Channel', $Channel)
    if ($Ref) { $arguments += @('-Ref', $Ref) }
    if ($Target) { $arguments += @('-Target', $Target) }
    if ($Port) { $arguments += @('-Port', $Port) }
    if ($TaskName) { $arguments += @('-TaskName', $TaskName) }
    # Вывод публикации — оператору на экран, а не в результат функции.
    & pwsh @arguments | Out-Host
    if ($LASTEXITCODE) {
        Write-Host 'Сборка или постановка панели не удалась — причина выше.' -ForegroundColor Red
        return $false
    }

    Write-Host ''
    $url = "http://localhost:$(if ($Port) { $Port } else { 5080 })"
    Write-Host "Панель поставлена: $url — и будет запускаться при входе. Базы знаний добавьте в её «Настройках»." -ForegroundColor Green
    Start-Process $url
    return $true
}

$installed = Install-AgentsKitPanel -Repository $Repository -Source $Source -Channel $Channel -Ref $Ref `
    -Target $Target -Port $Port -TaskName $TaskName
# Запуск файлом — код выхода для того, кто позвал; строкой «irm | iex» — ничего, окно оператора остаётся.
if (-not $installed -and $PSCommandPath) { exit 1 }
