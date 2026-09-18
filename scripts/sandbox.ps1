<#
.SYNOPSIS
Собирает одноразовую песочницу: выдуманные базы знаний и рабочие копии, на которых панель
можно ломать, не задевая живые базы.

.DESCRIPTION
Каталог песочницы лежит вне репозитория панели и вне баз знаний и собирается заново каждым
запуском: что бы в нём ни испортили, откат — повторный запуск. В песочнице два набора.

Здоровый — база с описанием, копиями, флоу, бэклогом и памятью задачи с вопросом оператору;
кит и агент отвечают как при удачной работе. На нём проверяется обычная работа панели.

Сломанный — отдельные базы и копии, каждая со своим изъяном: без описания, с битым
agents-kit.json, с копией, которой нет на диске, с памятью в CRLF и так далее.

Кит и агент Claude Code подменены заглушками: настоящий кит полез бы в живую сверку, а
настоящий агент стоит денег и прав. Заглушки умеют отвечать и здорово, и криво — как именно,
задают файлы kit-mode.txt и claude-mode.txt в корне песочницы; они читаются на каждый вызов,
и панель для смены режима перезапускать не нужно.

.EXAMPLE
pwsh -NoProfile -File scripts/sandbox.ps1

.EXAMPLE
pwsh -NoProfile -File scripts/sandbox.ps1 -Load -RealAgent
#>
param(
    # Каталог песочницы; пересобирается целиком при каждом запуске.
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\sandbox'),
    # Порт панели на песочнице: рядом работают поставленная панель и dev-копии.
    [int]$Port = 5090,
    # Собрать ещё базу на полсотни копий — посмотреть панель под опросом. Собирается долго.
    [switch]$Load,
    # Не подменять агента: панель будет звать настоящий claude. Деньги и настоящие права.
    [switch]$RealAgent,
    # Не поднимать процессы-пустышки под живые сессии агентов.
    [switch]$NoSessions
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = Split-Path $PSScriptRoot -Parent
$state = Join-Path $Root 'state.json'

function Write-Utf8([string]$Path, [string]$Text, [switch]$Crlf) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $body = if ($Crlf) { $Text -replace "`r?`n", "`r`n" } else { $Text -replace "`r`n", "`n" }
    [IO.File]::WriteAllText($Path, $body, [Text.UTF8Encoding]::new($false))
}

function Write-Json([string]$Path, $Value) {
    Write-Utf8 $Path ($Value | ConvertTo-Json -Depth 6)
}

# Репозиторий песочницы — настоящий git: список копий панель берёт из «git worktree list»,
# а флоу и бэклог она коммитит. Имя автора задаётся локально: у песочницы своих настроек нет.
function New-Repo([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    git -C $Path init -b main --quiet
    git -C $Path config user.name 'Песочница'
    git -C $Path config user.email 'sandbox@example.invalid'
    # Фикстура памяти с CRLF должна доехать до панели как записана.
    git -C $Path config core.autocrlf false
    git -C $Path config commit.gpgsign false
}

function Add-Commit([string]$Path, [string]$Message) {
    git -C $Path add -A
    git -C $Path commit -q -m $Message
}

# Процессы-пустышки под живые сессии агентов: панель считает сессию живой по её процессу,
# поэтому файл реестра без процесса — это фикстура мёртвой сессии, а не живая сессия.
function Start-Dummy {
    $process = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 86400')
    return $process.Id
}

function Stop-OldDummies {
    if (-not (Test-Path -LiteralPath $state)) { return }
    try { $old = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json } catch { return }
    foreach ($dummy in @($old.dummies)) {
        $process = Get-Process -Id $dummy -ErrorAction Ignore
        # Номера процессов Windows переиспользует: гасим только свою пустышку.
        if ($process -and $process.ProcessName -eq 'pwsh') { Stop-Process -Id $dummy -Force -ErrorAction Ignore }
    }
}

function Write-Session([string]$Dir, [int]$Process, [string]$Cwd, [hashtable]$Extra) {
    $session = [ordered]@{ pid = $Process; cwd = $Cwd; entrypoint = 'claude-vscode' }
    foreach ($key in $Extra.Keys) { $session[$key] = $Extra[$key] }
    Write-Json (Join-Path $Dir "$Process.json") ([pscustomobject]$session)
}

# --- заглушка кита -----------------------------------------------------------------------

# Кит подменён: настоящий полез бы в живую сверку и завёл бы настоящую копию. Состояние связи
# и находки сверки заглушка не вычисляет, а берёт из таблиц, которые пишет этот скрипт.
function New-Kit([string]$Path) {
    $scripts = Join-Path $Path 'scripts'

    Write-Utf8 (Join-Path $scripts 'link-state.ps1') @'
# Заглушка кита. Состояние связи копии — строка таблицы links.json рядом со скриптами;
# пути в таблице нет — копия под китом не числится.
function Get-KitLinkState([string]$Dir) {
    $table = Join-Path $PSScriptRoot 'links.json'
    $key = ($Dir -replace '/', '\').TrimEnd('\')
    $rows = if (Test-Path -LiteralPath $table) { @(Get-Content -LiteralPath $table -Raw | ConvertFrom-Json) } else { @() }
    foreach ($row in $rows) {
        if ($row.path -ieq $key) { return [pscustomobject]@{ status = $row.status; base = $row.base } }
    }
    return [pscustomobject]@{ status = 'NoPointer'; base = $null }
}
'@

    Write-Utf8 (Join-Path $scripts 'base-check.ps1') @'
. (Join-Path $PSScriptRoot 'link-state.ps1')

# Заглушка кита. Режим читается на каждый вызов из kit-mode.txt корня песочницы, поэтому
# панель для смены режима перезапускать не нужно:
#   ok       находки базы из findings.json
#   empty    ответа нет вовсе
#   garbage  в поток летит не JSON
#   huge     находок столько, что ответ огромный
#   fail     скрипт падает с текстом ошибки
#   hang     скрипт не отвечает, пока панель не сдастся по времени
function Get-KitSandboxMode {
    $file = $null
    $dir = $PSScriptRoot
    while ($dir) {
        $candidate = Join-Path $dir 'kit-mode.txt'
        if (Test-Path -LiteralPath $candidate) { $file = $candidate; break }
        $dir = Split-Path $dir -Parent
    }
    if (-not $file) { return 'ok' }
    $mode = (Get-Content -LiteralPath $file -Raw).Trim().ToLowerInvariant()
    if ($mode) { return $mode } else { return 'ok' }
}

function Get-KitBaseFindings([string]$BaseDir, [string]$Worktree) {
    switch (Get-KitSandboxMode) {
        'empty'   { exit 0 }
        'garbage' { Write-Output 'кит сегодня отвечает не по-json'; return @() }
        'hang'    { Start-Sleep -Seconds 600; return @() }
        'fail'    { throw "сверка базы $BaseDir не удалась: заглушка кита так настроена" }
        'huge'    {
            return @(1..4000 | ForEach-Object {
                [pscustomobject]@{
                    severity = 'WARN'
                    file     = "decisions/область-$_.md"
                    message  = "находка номер $_ — " + ('очень длинный текст находки; ' * 12)
                }
            })
        }
    }

    $table = Join-Path $PSScriptRoot 'findings.json'
    if (-not (Test-Path -LiteralPath $table)) { return @() }
    $key = ($BaseDir -replace '/', '\').TrimEnd('\')
    foreach ($row in @(Get-Content -LiteralPath $table -Raw | ConvertFrom-Json)) {
        if ($row.base -ieq $key) { return @($row.findings) }
    }
    return @()
}

# Панель это правило только повторяет у себя, но кит без него — не кит.
function Get-KitProjectName([string]$BaseDir) {
    $product = Join-Path $BaseDir 'product.md'
    if (-not (Test-Path -LiteralPath $product)) { return (Split-Path $BaseDir -Leaf) }
    foreach ($line in Get-Content -LiteralPath $product) {
        if ($line -match '^#\s+(.+?)\s*$') { return ($Matches[1] -replace '\s+—\s+продукт$', '') }
    }
    return (Split-Path $BaseDir -Leaf)
}
'@

    Write-Utf8 (Join-Path $scripts 'worktree-add.ps1') @'
# Заглушка кита: копию заводит настоящим git worktree, но рядом с копией песочницы и без
# связи с базой — проверяется, как панель зовёт кит и показывает его вывод.
param([Parameter(Mandatory)][string]$Path, [string]$Name)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) {
    throw "каталог $Path не под git — копию от него не завести"
}
$branch = if ($Name) { $Name } else { 'sandbox-' + [guid]::NewGuid().ToString('N').Substring(0, 6) }
$target = Join-Path (Split-Path $Path -Parent) $branch
git -C $Path worktree add -b $branch $target --quiet 2>&1 | Out-Null
"Копия заведена: $target, ветка $branch"
'@
}

# --- подставной агент --------------------------------------------------------------------

# Панель зовёт агента голым именем claude через PATH, поэтому в песочнице его перехватывает
# claude.cmd впереди PATH. Настоящий агент отвечает нормально, а панель ломается на кривом
# ответе — оборванном, мусорном, медленном; показать их может только подставной.
function New-ClaudeStub([string]$Path) {
    Write-Utf8 (Join-Path $Path 'claude.cmd') @'
@echo off
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-stub.ps1" %*
'@

    Write-Utf8 (Join-Path $Path 'claude-stub.ps1') @'
# Подставной агент Claude Code. Режим читается на каждый вызов из claude-mode.txt корня
# песочницы:
#   ok         как при удачной работе
#   garbage    вместо потока событий — не JSON
#   truncated  поток обрывается на середине, итога нет
#   slow       тот же ответ, но по строке раз в несколько секунд
#   fail       падает с ненулевым кодом
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$root = Split-Path $PSScriptRoot -Parent
$modeFile = Join-Path $root 'claude-mode.txt'
$mode = if (Test-Path -LiteralPath $modeFile) { (Get-Content -LiteralPath $modeFile -Raw).Trim().ToLowerInvariant() } else { 'ok' }
if (-not $mode) { $mode = 'ok' }

$arguments = @($args)
$stdin = if ([Console]::IsInputRedirected) { [Console]::In.ReadToEnd() } else { '' }

function Get-Argument([string]$Name) {
    for ($i = 0; $i -lt $arguments.Count - 1; $i++) {
        if ($arguments[$i] -eq $Name) { return $arguments[$i + 1] }
    }
    return $null
}

function Write-Line([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
    if ($mode -eq 'slow') { Start-Sleep -Seconds 6 }
}

function Write-Step([string]$Tool, [hashtable]$Payload) {
    $step = [pscustomobject]@{
        type    = 'assistant'
        message = [pscustomobject]@{ content = @([pscustomobject]@{ type = 'tool_use'; name = $Tool; input = [pscustomobject]$Payload }) }
    }
    Write-Line ($step | ConvertTo-Json -Depth 8 -Compress)
}

function Write-Result([string]$Text) {
    $outcome = [pscustomobject]@{
        type = 'result'; subtype = 'success'; is_error = $false; duration_ms = 1234; result = $Text
    }
    Write-Line ($outcome | ConvertTo-Json -Depth 8 -Compress)
}

if ($mode -eq 'fail') {
    [Console]::Error.WriteLine('подставной агент отказался работать: так задан режим песочницы')
    exit 1
}

# Запуск задачи: панель ждёт в выводе короткий id фоновой сессии.
if ($arguments -contains '--bg') {
    if ($mode -in @('garbage', 'truncated')) {
        Write-Line 'сессия вроде бы завелась, а id не скажу'
        exit 0
    }
    $id = [guid]::NewGuid().ToString('N').Substring(0, 8)
    Write-Line "Session backgrounded · $id"
    exit 0
}

if ($mode -eq 'garbage') {
    Write-Line 'здесь должен был быть поток событий агента'
    Write-Line '{ это почти json, но нет'
    exit 0
}

$baseDir = Get-Argument '--add-dir'

# Запись в бэклог: панель узнаёт итог по файлу — новым номерам закоммиченного backlog.md.
if ($baseDir) {
    $backlog = Join-Path $baseDir 'backlog.md'
    Write-Step 'Read' @{ file_path = $backlog }
    if ($mode -eq 'truncated') { exit 0 }

    $text = [IO.File]::ReadAllText($backlog)
    $number = if ($text -match '(?m)^следующий номер:\s*B-(\d+)\s*$') { [int]$Matches[1] } else { 1 }
    $said = $stdin.Trim()
    if (-not $said) { $said = 'Оператор ничего не сказал.' }
    $title = ($said -split "`n")[0]
    if ($title.Length -gt 70) { $title = $title.Substring(0, 70) }
    $text = $text -replace "(?m)^следующий номер:\s*B-\d+\s*$", "следующий номер: B-$($number + 1)"
    $text = $text.TrimEnd() + "`n`n## B-$number $title`n`n$said`n`n### Агенту`n- записано подставным агентом песочницы`n"
    [IO.File]::WriteAllText($backlog, $text, [Text.UTF8Encoding]::new($false))

    Write-Step 'Edit' @{ file_path = $backlog }
    git -C $baseDir commit -q -m 'Записано из панели' -- backlog.md
    Write-Result "Записал B-$number."
    exit 0
}

# Вопрос по базе: агент работает в каталоге базы и только читает.
$product = Join-Path (Get-Location).Path 'product.md'
Write-Step 'Read' @{ file_path = $product }
Write-Step 'Grep' @{ pattern = 'песочница' }
if ($mode -eq 'truncated') { exit 0 }
$question = $stdin.Trim()
Write-Result "Подставной агент песочницы отвечает на «$question»: настоящего ответа здесь нет и быть не может, зато видно, как панель показывает ход работы и итог."
exit 0
'@
}

# --- содержимое баз ----------------------------------------------------------------------

function New-Flow([string]$Path) {
    Write-Utf8 (Join-Path $Path 'flow.md') @'
# Песочница — флоу

## 1. Критерий

исполнитель: оркестратор
выход: критерий закрытия в памяти и ответ оператора, что критерий подтверждён

1.1. Написать критерий до первой строчки кода.
1.2. Вынести его оператору строкой «Оператору:» в памяти.

## 2. Ветка

исполнитель: оркестратор
выход: имя ветки в строке «ветка» памяти

2.1. Завести ветку задачи от обновлённого dev.

## 3. Реализация

исполнитель: оркестратор
выход: sha коммитов ветки и зелёные прогоны проверок в памяти

3.1. Вести работу шагами, каждый со своей проверкой.

## 4. Приёмка

исполнитель: оператор
выход: ответ оператора в памяти — «принято» или список замечаний
пропуск: правка не меняет ни вида, ни поведения панели

4.1. Показать оператору, что смотреть.

## 5. Мерж

исполнитель: оркестратор
выход: «смержено и запушено: <sha в dev>, ветка удалена» в памяти

5.1. Мержить только после «принято».
'@
}

function New-Backlog([string]$Path) {
    Write-Utf8 (Join-Path $Path 'backlog.md') @'
# Песочница — бэклог

следующий номер: B-3

## B-1 Кнопка «Обновить» не гасится, пока идёт опрос

Оператор жмёт её несколько раз подряд, и панель уходит опрашивать копии столько же раз.

### Агенту
- где: раздел «Копии»

## B-2 В пустой ячейке таблицы копий стоит тире

Тире читается как значение, которого нет, а не как «нечего показывать».

### Агенту
- где: таблица копий
'@
}

function New-Memory([string]$Path, [string]$Copy, [string]$Branch, [switch]$Crlf, [switch]$NoAnswerKey, [switch]$TwoQuestions) {
    $question = @'

## Оператору

### Переносить ли опрос копий на сервер?
Панель опрашивает копии из браузера раз в три секунды. Когда копий много, опрос заметен в выводе, а браузер держит соединение впустую.

- вариант: оставить опрос как есть — ничего не меняется, нагрузка растёт с числом копий
- вариант: перенести опрос на сервер — панель получает готовый снимок, но сервер держит состояние
- рекомендовано: оставить опрос как есть — ничего не меняется, нагрузка растёт с числом копий

ответ:
'@
    if ($NoAnswerKey) { $question = $question -replace "(?m)^ответ:\s*$", '' }
    if ($TwoQuestions) {
        $question += @'

### Гасить ли панель на ночь?
Панель работает всегда, хотя ночью её никто не открывает.

- вариант: гасить по расписанию — утром её надо будить руками
- вариант: не гасить — как сейчас

ответ:
'@
    }

    $text = @"
# B-7 Опрос копий не должен мешать работе

рабочая копия: $Copy
ветка: $Branch
Решения: нет

## Критерии закрытия

### 1. Таблица копий обновляется без рывков
Оператор открывает раздел «Копии» и видит, что строки обновляются, а страница при этом не дёргается.

### Не входит
Переделка вида таблицы.
$question

## Агенту

### Критерии
- 1. проверка: замер геометрии строк каждый кадр — где: e2e-прогон

### Вопросы
- «Переносить ли опрос копий на сервер?»: ответ решает, где живёт состояние опроса

### Факты
- Опрос идёт раз в три секунды.

### Флоу
- [x] 1. Критерий — выход: критерий записан выше
- [x] 2. Ветка — выход: feat/polling от dev
- [ ] 3. Реализация
- [ ] 4. Приёмка
- [ ] 5. Мерж

### Шаги
- [x] Замерить, сколько длится опрос — результат: 40 мс на копию — проверен: вывод прогона
- [ ] Свести опрос к одному запросу
"@
    Write-Utf8 $Path $text -Crlf:$Crlf
}

# Выдуманная база знаний: та же раскладка, что у настоящей, — панель читает её теми же правилами.
function New-Base([string]$Path, [string]$Title, [string[]]$Copies, [switch]$NoProduct, [switch]$BrokenJson) {
    New-Repo $Path
    if (-not $NoProduct) {
        Write-Utf8 (Join-Path $Path 'product.md') @"
# $Title — продукт

## Что за система

- Выдуманный проект песочницы: нужен, чтобы панели было что показывать.
- Живого кода за ним нет.
"@
    }
    if ($BrokenJson) {
        Write-Utf8 (Join-Path $Path 'agents-kit.json') '{ "kit": "agents-kit", "workspaces": [ тут оборвалось'
    }
    else {
        Write-Json (Join-Path $Path 'agents-kit.json') ([pscustomobject]@{ kit = 'agents-kit'; workspaces = $Copies })
    }
    New-Flow $Path
    New-Backlog $Path
    New-Item -ItemType Directory -Path (Join-Path $Path 'work') -Force | Out-Null
    Write-Utf8 (Join-Path $Path '.gitignore') "local/`n"
    Add-Commit $Path 'Каркас базы песочницы'
}

# --- сборка ------------------------------------------------------------------------------

Stop-OldDummies
if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
New-Item -ItemType Directory -Path $Root -Force | Out-Null

$panelDir = Join-Path $Root 'panel'
$sessionsDir = Join-Path $Root 'sessions'
$claudeDir = Join-Path $Root 'claude'
$binDir = Join-Path $Root 'bin'
$basesDir = Join-Path $Root 'bases'
$copiesDir = Join-Path $Root 'copies'
foreach ($dir in @($panelDir, $sessionsDir, $claudeDir, $binDir, $basesDir, $copiesDir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$kitDir = Join-Path $claudeDir 'skills\agents-kit'
New-Kit $kitDir
New-ClaudeStub $binDir
Write-Utf8 (Join-Path $Root 'kit-mode.txt') "ok`n"
Write-Utf8 (Join-Path $Root 'claude-mode.txt') "ok`n"

$links = [Collections.Generic.List[object]]::new()
$findings = [Collections.Generic.List[object]]::new()
$bases = [Collections.Generic.List[string]]::new()
$dummies = [Collections.Generic.List[int]]::new()

# --- здоровый набор ----------------------------------------------------------------------

$goodCopy = Join-Path $copiesDir 'house'
$goodBase = Join-Path $basesDir 'house-knowledge'
New-Repo $goodCopy
Write-Utf8 (Join-Path $goodCopy 'README.md') "# Дом`n`nВыдуманный проект песочницы.`n"
Add-Commit $goodCopy 'Первый коммит'
$goodWorktree = Join-Path $copiesDir 'house-task'
git -C $goodCopy worktree add -b feat/polling $goodWorktree --quiet

New-Base $goodBase 'Дом' @($goodCopy)
New-Memory (Join-Path $goodBase 'work\house-task.md') $goodWorktree 'feat/polling'
Add-Commit $goodBase 'Память задачи'
$bases.Add($goodBase)
foreach ($copy in @($goodCopy, $goodWorktree)) {
    $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $goodBase })
}
$findings.Add([pscustomobject]@{ base = $goodBase; findings = @() })

# --- таблицы заглушки кита и настройки панели --------------------------------------------

Write-Json (Join-Path $kitDir 'scripts\links.json') $links.ToArray()
Write-Json (Join-Path $kitDir 'scripts\findings.json') $findings.ToArray()
Write-Json (Join-Path $panelDir 'bases.json') ([pscustomobject]@{ bases = $bases.ToArray(); kit = $kitDir })

# --- живые сессии агентов ----------------------------------------------------------------

if (-not $NoSessions) {
    $working = Start-Dummy
    $dummies.Add($working)
    Write-Session $sessionsDir $working $goodCopy @{ status = 'busy' }

    $background = Start-Dummy
    $dummies.Add($background)
    Write-Session $sessionsDir $background $goodWorktree @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'a1b2c3d4'; status = 'waiting' }
}

Write-Json $state ([pscustomobject]@{ dummies = $dummies.ToArray(); port = $Port; root = $Root })

# --- строка запуска ----------------------------------------------------------------------

$api = Join-Path $repo 'backend\src\AgentsKitWeb.Api'
$pathLine = if ($RealAgent) {
    '# агент настоящий: claude берётся из PATH как обычно'
}
else {
    "`$env:PATH = '$binDir;' + `$env:PATH"
}

Write-Utf8 (Join-Path $Root 'start-panel.ps1') @"
# Поднимает панель на песочнице. Живых баз она при этом не видит: список баз, реестр сессий
# и профиль Claude Code взяты из песочницы, а не из профиля оператора.
`$ErrorActionPreference = 'Stop'
$pathLine
dotnet run --project '$api' --no-launch-profile -- ``
    --urls 'http://localhost:$Port' ``
    --BasesFile '$(Join-Path $panelDir 'bases.json')' ``
    --SessionsDir '$sessionsDir' ``
    --ClaudeDir '$claudeDir'
"@

Write-Host ""
Write-Host "Песочница собрана: $Root"
Write-Host ""
Write-Host "  запуск панели:  pwsh -NoProfile -File `"$(Join-Path $Root 'start-panel.ps1')`""
Write-Host "  адрес панели:   http://localhost:$Port"
Write-Host "  режим кита:     $(Join-Path $Root 'kit-mode.txt')     (ok, empty, garbage, huge, fail, hang)"
Write-Host "  режим агента:   $(Join-Path $Root 'claude-mode.txt')  (ok, garbage, truncated, slow, fail)"
Write-Host ""
Write-Host "  пересобрать:    pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'sandbox.ps1')`""
Write-Host ""
