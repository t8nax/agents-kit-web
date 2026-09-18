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
    [switch]$NoSessions,
    # Не собирать песочницу, а сверить живое состояние со снимком, снятым при сборке.
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = Split-Path $PSScriptRoot -Parent
$state = Join-Path $Root 'state.json'

# Снимок живого состояния: список отслеживаемых баз оператора и каждая живая база — её HEAD
# и незакоммиченные правки. Песочница ничего этого касаться не должна, и «-Verify» это показывает.
# Живые базы меняют и соседние сессии, поэтому расхождение называет файл: по нему видно, чья это
# работа — панели песочницы или сессии в другой копии.
function Get-LiveSnapshot {
    $file = Join-Path $env:APPDATA 'agents-kit-webases.json'
    $snapshot = [ordered]@{ basesFile = $null; bases = [ordered]@{} }
    if (-not (Test-Path -LiteralPath $file)) { return $snapshot }
    $snapshot.basesFile = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $live = try { (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).bases } catch { @() }
    foreach ($base in @($live)) {
        if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
        $head = (git -C $base rev-parse HEAD 2>$null) -join ''
        $dirty = (git -C $base status --porcelain 2>$null) -join "`n"
        $snapshot.bases[$base] = [ordered]@{ head = $head; dirty = $dirty }
    }
    return $snapshot
}

function Compare-Live([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) {
        throw "снимка живого состояния нет: $File — сначала соберите песочницу"
    }
    $before = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    $after = Get-LiveSnapshot
    $changes = [Collections.Generic.List[string]]::new()
    if ($before.basesFile -ne $after.basesFile) { $changes.Add('список отслеживаемых баз оператора (bases.json) изменился') }
    foreach ($base in $before.bases.PSObject.Properties) {
        $now = $after.bases[$base.Name]
        if (-not $now) { $changes.Add("база $($base.Name) пропала из списка"); continue }
        if ($base.Value.head -ne $now.head) { $changes.Add("в базе $($base.Name) новый коммит") }
        if ($base.Value.dirty -ne $now.dirty) {
            $changes.Add("в базе $($base.Name) изменились незакоммиченные правки:")
            foreach ($line in @(($now.dirty -split "`n") | Where-Object { $_ })) { $changes.Add("    $line") }
        }
    }
    if ($changes.Count -eq 0) {
        Write-Host "Живое состояние не изменилось: список баз оператора и живые базы те же."
        return
    }
    Write-Host "Живое состояние изменилось:"
    foreach ($line in $changes) { Write-Host "  $line" }
    Write-Host ""
    Write-Host "Панель песочницы живых баз не видит вовсе, поэтому загляните, чья это работа:"
    Write-Host "почти всегда — сессия агента в другой рабочей копии, которая коммитит свою память."
}

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
        # Печатаем мимо возвращаемого значения: Write-Output стал бы находкой, а не мусором в потоке.
        'garbage' { [Console]::Out.WriteLine('кит сегодня отвечает не по-json'); return @() }
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
# свой claude впереди PATH. Настоящий агент отвечает нормально, а панель ломается на кривом
# ответе — оборванном, мусорном, медленном; показать их может только подставной.
#
# Подменять нужно именно claude.exe: панель запускает процесс без оболочки, а CreateProcess
# Windows дописывает к имени только «.exe» и claude.cmd не видит — с ним панель звала бы
# настоящего агента. Исполняемую обёртку собирает Windows PowerShell: в pwsh компиляции в exe
# нет. Обёртка ничего не делает сама — зовёт claude-stub.ps1, отдав ему свои аргументы
# переменной окружения, а потоки ввода и вывода достаются заглушке по наследству.
function New-ClaudeStub([string]$Path) {
    Write-Utf8 (Join-Path $Path 'claude-shim.cs') @'
using System;
using System.Diagnostics;
using System.IO;

public static class ClaudeShim
{
    public static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(typeof(ClaudeShim).Assembly.Location);
        var start = new ProcessStartInfo("pwsh");
        start.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "claude-stub.ps1") + "\"";
        start.UseShellExecute = false;
        // Аргументы уходят переменной окружения: среди них многострочный системный промпт,
        // который в командной строке пришлось бы экранировать.
        start.EnvironmentVariables["AKW_CLAUDE_ARGS"] = string.Join(((char)1).ToString(), args);
        using (var process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
'@

    $exe = Join-Path $Path 'claude.exe'
    $source = Join-Path $Path 'claude-shim.cs'
    & powershell.exe -NoProfile -NonInteractive -Command         "Add-Type -TypeDefinition (Get-Content -Raw '$source') -OutputAssembly '$exe' -OutputType ConsoleApplication" | Out-Null
    if (-not (Test-Path -LiteralPath $exe)) { throw "не собралась подмена агента: $exe" }

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

# Аргументы приходят от обёртки claude.exe переменной окружения: в командной строке
# многострочный системный промпт пришлось бы экранировать.
$arguments = if ($env:AKW_CLAUDE_ARGS) { @($env:AKW_CLAUDE_ARGS -split [char]1) } else { @($args) }
# Текст оператора приходит в stdin в UTF-8: читаем поток сами, иначе консоль отдаст его
# в кодировке по умолчанию и русские буквы приедут мусором.
$stdin = if ([Console]::IsInputRedirected) {
    $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
    $reader.ReadToEnd()
} else { '' }

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

# Гашение сессии: настоящий claude stop завершает её процесс, и файл реестра за ним исчезает.
# Здесь то же самое: гаснет пустышка, которой заведена сессия, и уходит её файл — иначе не видно,
# как строка пропадает из перечня.
if ($arguments.Count -ge 2 -and $arguments[0] -eq 'stop') {
    $wanted = $arguments[1]
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'sessions') -Filter '*.json' -ErrorAction Ignore) {
        $session = try { Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $null }
        if (-not $session -or $session.jobId -ne $wanted) { continue }
        $process = Get-Process -Id $session.pid -ErrorAction Ignore
        # Номера процессов Windows переиспользует: гасим только свою пустышку.
        if ($process -and $process.ProcessName -eq 'pwsh') { Stop-Process -Id $session.pid -Force -ErrorAction Ignore }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Ignore
        Write-Line "Session $wanted stopped"
        exit 0
    }
    [Console]::Error.WriteLine("no such session: $wanted")
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
    # Панель шлёт агенту вызов навыка кита с текстом оператора: заголовок записи — сам текст.
    $said = ($stdin -replace '(?m)^\s*/[\w:-]+\s*', '').Trim()
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
function New-Base([string]$Path, [string]$Title, [string[]]$Copies, [switch]$NoProduct, [switch]$BrokenJson, [switch]$FlowUncommitted) {
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
    if (-not $FlowUncommitted) { New-Flow $Path }
    New-Backlog $Path
    New-Item -ItemType Directory -Path (Join-Path $Path 'work') -Force | Out-Null
    Write-Utf8 (Join-Path $Path '.gitignore') "local/`n"
    Add-Commit $Path 'Каркас базы песочницы'
    # Флоу, которого нет в истории: панель коммитит правку без git add, и такой файл ей не закоммитить.
    if ($FlowUncommitted) { New-Flow $Path }
}

# --- сборка ------------------------------------------------------------------------------

if ($Verify) {
    Compare-Live (Join-Path $Root 'live-snapshot.json')
    return
}

$live = Get-LiveSnapshot

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

# --- сломанный набор ---------------------------------------------------------------------

# Каждая кривая база отдельная: сломанное не должно мешать здоровому набору.

# База без описания проекта: название панель возьмёт из имени папки.
$noProductCopy = Join-Path $copiesDir 'nameless'
New-Repo $noProductCopy
Write-Utf8 (Join-Path $noProductCopy 'README.md') "# Проект без описания в базе`n"
Add-Commit $noProductCopy 'Первый коммит'
$noProductBase = Join-Path $basesDir 'no-product'
New-Base $noProductBase 'Без описания' @($noProductCopy) -NoProduct
$links.Add([pscustomobject]@{ path = $noProductCopy; status = 'Linked'; base = $noProductBase })
$bases.Add($noProductBase)
$findings.Add([pscustomobject]@{ base = $noProductBase; findings = @(
    [pscustomobject]@{ severity = 'FAIL'; file = 'product.md'; message = 'нет product.md — название проекта взять неоткуда' }) })

# База с битым agents-kit.json: список копий не прочитать.
$brokenJsonBase = Join-Path $basesDir 'broken-json'
New-Base $brokenJsonBase 'Битый список копий' @() -BrokenJson
$bases.Add($brokenJsonBase)
$findings.Add([pscustomobject]@{ base = $brokenJsonBase; findings = @(
    [pscustomobject]@{ severity = 'FAIL'; file = 'agents-kit.json'; message = 'список копий не разобран' }) })

# Кривые копии: одной нет на диске, вторая не под git, третья с кириллицей в пути,
# четвёртая записана через «..».
$cyrillicCopy = Join-Path $copiesDir 'копия-с-кириллицей'
New-Repo $cyrillicCopy
Write-Utf8 (Join-Path $cyrillicCopy 'README.md') "# Копия с кириллицей`n"
Add-Commit $cyrillicCopy 'Первый коммит'

$notGitCopy = Join-Path $copiesDir 'not-git'
New-Item -ItemType Directory -Path $notGitCopy -Force | Out-Null
Write-Utf8 (Join-Path $notGitCopy 'README.md') "# Копия вне git`n"

$dottedCopy = Join-Path $copiesDir 'dotted\..\dotted'
New-Repo (Join-Path $copiesDir 'dotted')
Write-Utf8 (Join-Path $copiesDir 'dotted\README.md') "# Копия, записанная через «..»`n"
Add-Commit (Join-Path $copiesDir 'dotted') 'Первый коммит'

$goneCopy = Join-Path $copiesDir 'gone'

$quirksBase = Join-Path $basesDir 'quirks'
New-Base $quirksBase 'Кривые копии' @($cyrillicCopy, $notGitCopy, $dottedCopy, $goneCopy) -FlowUncommitted
$bases.Add($quirksBase)

# Память с CRLF — на копию с кириллицей.
New-Memory (Join-Path $quirksBase 'work\копия-с-кириллицей.md') $cyrillicCopy 'main' -Crlf
# Вопрос без строки «ответ:» — панели нечего заполнить, а форма памяти нарушена.
New-Memory (Join-Path $quirksBase 'work\dotted.md') $dottedCopy 'main' -NoAnswerKey
# Несколько вопросов в одной памяти.
New-Memory (Join-Path $quirksBase 'work\not-git.md') $notGitCopy 'main' -TwoQuestions
# Две памяти на одну копию: какая из них настоящая, панель не знает.
New-Memory (Join-Path $quirksBase 'work\копия-с-кириллицей-вторая.md') $cyrillicCopy 'feat/вторая'
Add-Commit $quirksBase 'Памяти кривых копий'

# Незакоммиченная правка бэклога: агент записи унёс бы её в свой коммит.
Add-Content -LiteralPath (Join-Path $quirksBase 'backlog.md') -Value "`n## Запись без номера, дописанная руками`n" -Encoding utf8NoBOM

$links.Add([pscustomobject]@{ path = $cyrillicCopy; status = 'Linked'; base = $quirksBase })
$links.Add([pscustomobject]@{ path = $notGitCopy; status = 'NotGit'; base = $null })
$links.Add([pscustomobject]@{ path = (Join-Path $copiesDir 'dotted'); status = 'Unlisted'; base = $quirksBase })
$findings.Add([pscustomobject]@{ base = $quirksBase; findings = @(
    [pscustomobject]@{ severity = 'FAIL'; file = 'work/копия-с-кириллицей-вторая.md'; message = 'две памяти на одну копию' }
    [pscustomobject]@{ severity = 'WARN'; file = 'backlog.md'; message = 'запись без номера' }
    [pscustomobject]@{ severity = 'WARN'; file = 'flow.md'; message = 'флоу не в истории git' }) })

# Кит без скриптов: путь к нему панель не примет, и это видно в «Настройках».
$brokenKit = Join-Path $claudeDir 'skills\agents-kit-broken'
New-Item -ItemType Directory -Path (Join-Path $brokenKit 'scripts') -Force | Out-Null
Write-Utf8 (Join-Path $brokenKit 'README.md') "# Кит без скриптов`n`nПуть сюда панель принять не должна.`n"

# Файл сессии на мёртвый процесс: он переживает свою сессию, живость видна только по процессу,
# поэтому в строке этой копии панель работы показать не должна.
Write-Session $sessionsDir 999123 (Join-Path $copiesDir 'dotted') @{ status = 'busy' }

# База на полсотни копий: по ключу -Load, потому что собирается заметно дольше остального.
if ($Load) {
    $loadCopy = Join-Path $copiesDir 'load'
    New-Repo $loadCopy
    Write-Utf8 (Join-Path $loadCopy 'README.md') "# Копия под нагрузку`n"
    Add-Commit $loadCopy 'Первый коммит'
    $loadBase = Join-Path $basesDir 'load-knowledge'
    New-Base $loadBase 'Полсотни копий' @($loadCopy)
    $links.Add([pscustomobject]@{ path = $loadCopy; status = 'Linked'; base = $loadBase })
    foreach ($i in 1..50) {
        $worktree = Join-Path $copiesDir "load-$i"
        git -C $loadCopy worktree add -b "load/$i" $worktree --quiet
        $links.Add([pscustomobject]@{ path = $worktree; status = 'Linked'; base = $loadBase })
        if ($i % 5 -eq 0) { New-Memory (Join-Path $loadBase "work\load-$i.md") $worktree "load/$i" }
    }
    Add-Commit $loadBase 'Памяти копий под нагрузку'
    $bases.Add($loadBase)
    $findings.Add([pscustomobject]@{ base = $loadBase; findings = @() })
}

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

    # Отработавшая сессия задачи: копия свободна — памяти у неё нет, — а сессия стоит без дела.
    # Такую панель гасит сама, и в песочнице видно, как её строка уходит из перечня.
    $finished = Start-Dummy
    $dummies.Add($finished)
    Write-Session $sessionsDir $finished $goodCopy @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'f1e2d3c4'; status = 'idle' }
    # Ту самую сессию задачи копии панель знает только по своему запуску — отсюда и эта запись.
    Write-Json (Join-Path $panelDir 'task-sessions.json') ([pscustomobject]@{
            sessions = @([pscustomobject]@{ copy = $goodCopy; session = 'f1e2d3c4' }) })
}

Write-Json $state ([pscustomobject]@{ dummies = $dummies.ToArray(); port = $Port; root = $Root })
Write-Json (Join-Path $Root 'live-snapshot.json') $live

# --- строка запуска ----------------------------------------------------------------------

$api = Join-Path $repo 'backend\src\AgentsKitWeb.Api'
$frontend = Join-Path $repo 'frontend'
$apiPort = $Port + 1
$pathLine = if ($RealAgent) {
    '# агент настоящий: claude берётся из PATH как обычно'
}
else {
    "`$env:PATH = '$binDir;' + `$env:PATH"
}

# Панель — это фронт и API, как в разработке: API отдаёт собранный фронт только в поставленной
# панели, а песочница работает на том коде, что лежит в рабочей копии. Поэтому скрипт поднимает
# оба: API на своём порту, а dev-сервер фронта — на том, который открывает оператор, и он же
# проксирует на API.
Write-Utf8 (Join-Path $Root 'start-panel.ps1') @"
# Поднимает панель на песочнице: API и dev-сервер фронта. Живых баз панель не видит — список баз,
# реестр сессий и профиль Claude Code взяты из песочницы, а не из профиля оператора.
# Гасится Ctrl+C: API останавливается вместе с фронтом.
`$ErrorActionPreference = 'Stop'
$pathLine

if (-not (Test-Path -LiteralPath '$(Join-Path $frontend 'node_modules')')) {
    throw 'нет node_modules фронта — сначала «npm install» в frontend'
}

`$api = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-Command',
    "dotnet run --project '$api' --no-launch-profile -- --urls 'http://localhost:$apiPort' --BasesFile '$(Join-Path $panelDir 'bases.json')' --SessionsDir '$sessionsDir' --ClaudeDir '$claudeDir' --FinishedSessionIntervalSeconds 10 --FinishedSessionDelaySeconds 20")

try {
    `$env:WEB_PORT = '$Port'
    `$env:API_PORT = '$apiPort'
    Write-Host 'Панель песочницы: http://localhost:$Port (API на $apiPort)'
    Push-Location '$frontend'
    npm run dev
}
finally {
    Pop-Location
    # dotnet run держит API отдельным дочерним процессом: гасим всё дерево.
    & taskkill.exe /PID `$api.Id /T /F 2>`$null | Out-Null
}
"@

Write-Host ""
Write-Host "Песочница собрана: $Root"
Write-Host ""
Write-Host "  запуск панели:  pwsh -NoProfile -File `"$(Join-Path $Root 'start-panel.ps1')`""
Write-Host "  адрес панели:   http://localhost:$Port   (API рядом, на $apiPort)"
Write-Host "  режим кита:     $(Join-Path $Root 'kit-mode.txt')     (ok, empty, garbage, huge, fail, hang)"
if ($RealAgent) {
    Write-Host "  агент:          настоящий claude из PATH — это деньги и настоящие права"
}
else {
    Write-Host "  режим агента:   $(Join-Path $Root 'claude-mode.txt')  (ok, garbage, truncated, slow, fail)"
}
Write-Host ""
Write-Host "  пересобрать:    pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'sandbox.ps1')`""
Write-Host "  сверить живое:  pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'sandbox.ps1')`" -Verify"
Write-Host ""
