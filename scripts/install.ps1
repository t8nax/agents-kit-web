<#
.SYNOPSIS
Ставит кит, если его нет, и панель готовой сборкой с GitHub.

.DESCRIPTION
Скрипт для другого компьютера: его скачивают и запускают одной строкой в Windows PowerShell,
поэтому он сам идёт в Windows PowerShell 5.1 и не требует ничего, чего нет на чистой Windows.

Сначала проверяет, есть ли Claude Code со входом в аккаунт: без него панели работать не с чем,
и тогда он говорит, что поставить, и больше ничего не делает. Затем ставит через winget то,
без чего панель не работает, — git и PowerShell 7: ими она пишет в базы и зовёт скрипты кита.
Кита нет — ставит его из магазина плагинов Claude Code. Панель не собирает: скачивает готовую
сборку последнего выпуска канала, раскладывает её и ставит тем же deploy.ps1 из сборки,
которым ставит себя обновление.
Дальше панель обновляет себя сама, кнопкой в «Настройках».

Список баз и путь к киту не переносятся: их задают в «Настройках» панели.

.EXAMPLE
iex ((irm https://raw.githubusercontent.com/t8nax/agents-kit-web/master/scripts/install.ps1).TrimStart([char]0xFEFF))

Файл хранится с BOM, иначе Windows PowerShell прочтёт русский текст запуском файлом неверно;
а скачанный строкой, он нёс бы BOM перед param и не разобрался бы — отсюда TrimStart.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Channel dev -Target D:\tmp\akw-app -Port 5099 -TaskName 'akw probe'
#>
param(
    [string]$Releases = 't8nax/agents-kit-web',
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    # Выпуск, который ставить; не назван — самый свежий выпуск канала.
    [string]$Tag,
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel'
)

# Всё внутри функции: строкой «irm | iex» скрипт идёт в сессии оператора, и exit закрыл бы ему окно.
function Install-AgentsKitPanel {
    param($Releases, $Channel, $Tag, $Target, $Port, $TaskName)

    $ErrorActionPreference = 'Stop'
    # Полоса хода Invoke-WebRequest в Windows PowerShell замедляет скачивание в разы.
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 без этого может не договориться с GitHub.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

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

    function Install-Tool($tool) {
        if (& $tool.Test) { return $true }
        # Оператор видит, почему ставится то, что у него вроде бы есть: чаще всего — старая версия.
        $found = if ($tool.Found) { & $tool.Found }
        $why = if ($found) { $found } else { "$($tool.Name) не найден" }
        if (-not (Test-Command 'winget')) {
            Write-Host "$why, и поставить его нечем: на компьютере нет winget (App Installer из Microsoft Store)." -ForegroundColor Red
            return $false
        }
        Write-Host "$why — ставлю $($tool.Name). Windows может спросить разрешение на установку."
        winget install --id $tool.Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
        $code = $LASTEXITCODE
        Update-Path
        if (& $tool.Test) { return $true }
        if ($code) { Write-Host "Установка через winget не прошла (код $code) — причина выше." -ForegroundColor Red }
        else {
            # winget отработал, а проверка по-прежнему видит старое: новое, скорее всего, стоит в PATH позже.
            $still = if ($tool.Found) { & $tool.Found }
            if ($still) { Write-Host "После установки: $still — возможно, старый стоит в PATH раньше нового." -ForegroundColor Red }
        }
        Write-Host "$($tool.Name) не поставился — поставьте его руками и запустите команду снова." -ForegroundColor Red
        return $false
    }

    # winget меняет PATH в реестре, а не в этом процессе: без перечитывания только что поставленное не видно.
    # Только дописать новые записи: строкой «irm | iex» это PATH окна оператора, и его добавки остаются.
    function Update-Path {
        $known = $env:Path -split ';'
        foreach ($scope in 'Machine', 'User') {
            foreach ($entry in [Environment]::GetEnvironmentVariable('Path', $scope) -split ';') {
                if ($entry -and $known -notcontains $entry) { $env:Path += ";$entry"; $known += $entry }
            }
        }
    }

    Write-Host 'Проверяю, есть ли то, с чем работает панель…'
    $missing = @()
    if (Test-Command 'claude') {
        if (Test-ClaudeLogin) { Write-Host '  Claude Code: есть, вход выполнен' }
        else { $missing += 'вход в Claude Code по подписке Claude — запустите claude и войдите командой /login' }
    }
    else { $missing += 'Claude Code — https://claude.com/claude-code, затем запустите claude и войдите по подписке Claude' }

    if ($missing) {
        Write-Host ''
        Write-Host 'Панель не поставлена: на компьютере не хватает того, без чего она не работает.' -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        Write-Host 'Поставьте недостающее и запустите эту же команду снова.'
        return $false
    }

    $tools = @(
        @{ Name = 'git'; Id = 'Git.Git'; Test = { Test-Command 'git' } },
        @{ Name = 'PowerShell 7'; Id = 'Microsoft.PowerShell'; Test = { Test-Command 'pwsh' } }
    )
    foreach ($tool in $tools) { if (-not (Install-Tool $tool)) { return $false } }

    # Кит ставится после git: магазин плагинов Claude Code клонирует его репозиторий.
    # Уже стоящий кит — из магазина или клоном для правки кита — не трогается.
    $kit = Find-Kit
    if ($kit) { Write-Host "  кит: $kit" }
    else {
        Write-Host 'Кит agents-kit не найден — ставлю его из магазина плагинов Claude Code.'
        # Магазин мог быть добавлен раньше без самого кита — тогда add откажет, а install всё равно пройдёт.
        claude plugin marketplace add t8nax/agents-kit | Out-Host
        claude plugin install agents-kit@agents-kit | Out-Host
        $kit = Find-Kit
        if (-not $kit) {
            Write-Host 'Кит не поставился — причина выше. Поставьте его по https://github.com/t8nax/agents-kit и запустите команду снова.' -ForegroundColor Red
            return $false
        }
        Write-Host "  кит поставлен: $kit"
    }

    $headers = @{ 'User-Agent' = 'agents-kit-web' }
    if (-not $Tag) {
        # Выпуски master — обычные v<номер>, выпуски dev — предварительные v<номер>-dev. Выпуск dev выходит
        # на каждое слияние, и master бывает дальше первой сотни: страницы листаются, пока канал не найден.
        $pattern = if ($Channel -eq 'dev') { '^v(\d+\.\d+\.\d+)-dev$' } else { '^v(\d+\.\d+\.\d+)$' }
        $found = @()
        for ($page = 1; $page -le 5 -and -not $found; $page++) {
            try { $answer = Invoke-RestMethod "https://api.github.com/repos/$Releases/releases?per_page=100&page=$page" -Headers $headers }
            catch {
                Write-Host "GitHub не ответил: $($_.Exception.Message)" -ForegroundColor Red
                return $false
            }
            # Windows PowerShell отдаёт массив ответа одним объектом — foreach его разворачивает.
            $batch = @(foreach ($release in $answer) { $release })
            $found = @($batch | Where-Object { $_.tag_name -match $pattern -and -not $_.draft })
            if ($batch.Count -lt 100) { break }
        }
        $Tag = $found | Sort-Object { [version]($_.tag_name -replace $pattern, '$1') } |
            Select-Object -Last 1 -ExpandProperty tag_name
        if (-not $Tag) {
            Write-Host "В канале $Channel на GitHub нет ни одного выпуска панели." -ForegroundColor Red
            return $false
        }
    }

    # Сборка раскладывается рядом с каталогом панели: подмена — перенос каталога в пределах одного диска.
    $archive = "$Target.zip"
    $staging = "$Target.new"
    $scripts = Join-Path ([IO.Path]::GetTempPath()) 'agents-kit-web-install'
    New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
    try {
        Write-Host "Скачиваю готовую панель $Tag…"
        Invoke-WebRequest "https://github.com/$Releases/releases/download/$Tag/agents-kit-web-win-x64.zip" `
            -OutFile $archive -Headers $headers -UseBasicParsing
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        Expand-Archive -LiteralPath $archive -DestinationPath $staging

        # Постановка — скриптом из сборки, но запущенным из копии: сборку он сам переносит на место панели.
        if (Test-Path $scripts) { Remove-Item $scripts -Recurse -Force }
        New-Item -ItemType Directory -Path $scripts | Out-Null
        Copy-Item (Join-Path $staging 'scripts\deploy.ps1') $scripts
        & pwsh -NoProfile -File (Join-Path $scripts 'deploy.ps1') -Source $staging -Target $Target -Port $Port -TaskName $TaskName |
            Out-Host
        if ($LASTEXITCODE) {
            Write-Host 'Постановка панели не удалась — причина выше.' -ForegroundColor Red
            return $false
        }
    }
    catch {
        Write-Host "Панель не поставлена: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    finally {
        if (Test-Path $archive) { Remove-Item $archive -Force }
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        if (Test-Path $scripts) { Remove-Item $scripts -Recurse -Force }
    }

    Write-Host ''
    $url = "http://localhost:$Port"
    Write-Host "Панель поставлена: $url — и будет запускаться при входе. Базы знаний добавьте в её «Настройках»." -ForegroundColor Green
    Start-Process $url
    return $true
}

$installed = Install-AgentsKitPanel -Releases $Releases -Channel $Channel -Tag $Tag `
    -Target $Target -Port $Port -TaskName $TaskName
# Запуск файлом — код выхода для того, кто позвал; строкой «irm | iex» — ничего, окно оператора остаётся.
if (-not $installed -and $PSCommandPath) { exit 1 }
