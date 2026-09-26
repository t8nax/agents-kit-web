# Кирпичи песочницы: запись файлов, git-репозитории, пустышки сессий, заглушки кита и агента.
# Подключается точкой из scripts/sandbox.ps1; ими же пишется свой кусок задачи.

function Write-Utf8([string]$Path, [string]$Text, [switch]$Crlf) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $body = if ($Crlf) { $Text -replace "`r?`n", "`r`n" } else { $Text -replace "`r`n", "`n" }
    [IO.File]::WriteAllText($Path, $body, [Text.UTF8Encoding]::new($false))
}

function Write-Json([string]$Path, $Value) {
    Write-Utf8 $Path ($Value | ConvertTo-Json -Depth 6)
}

# Репозиторий выдуманного проекта — настоящий git: список копий панель берёт из «git worktree list»,
# а флоу и бэклог она коммитит. Имя автора задаётся локально: своих настроек у каталога нет.
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

function Write-Session([string]$Dir, [int]$Process, [string]$Cwd, [hashtable]$Extra) {
    $session = [ordered]@{ pid = $Process; cwd = $Cwd; entrypoint = 'claude-vscode' }
    foreach ($key in $Extra.Keys) { $session[$key] = $Extra[$key] }
    Write-Json (Join-Path $Dir "$Process.json") ([pscustomobject]$session)
}

# --- заглушка кита -----------------------------------------------------------------------

# Кит подменён: настоящий полез бы в живую сверку и завёл бы настоящую копию. Состояние связи
# и находки сверки заглушка не вычисляет, а берёт из таблиц, которые пишет этот скрипт.
# $Rules — справка кита о флоу (reference/flow-stages.md установленного кита): из неё панель подаёт
# агенту правила формы этапа. Не нашлась — заглушка кладёт короткую свою, чтобы переписывание не отвечало отказом.
function New-Kit([string]$Path, [string]$Rules) {
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

    Write-Utf8 (Join-Path $scripts 'agents-deploy.ps1') @'
# Заглушка кита. Настоящий довоз кладёт исполнителей базы в копию и прячет их от её git;
# песочнице хватает того, что прогон есть, что-то печатает и ничего не ломает.
param([string]$Path = (Get-Location).Path)
Write-Host "Рабочая копия: $Path"
Write-Host 'Довезено: 0, обновлено: 0, убрано: 0'
'@

    Write-Utf8 (Join-Path $scripts 'worktree-add.ps1') @'
# Заглушка кита: копию заводит настоящим git worktree рядом с исходной — проверяется, как панель
# зовёт кит и показывает его вывод. С базой заведённую копию заглушка не связывает: под китом
# она не числится, и на ней видно, как панель показывает проблему связи.
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

    Write-Utf8 (Join-Path $scripts 'worktree-remove.ps1') @'
# Заглушка кита: копию убирает настоящим git worktree, но отказы проверяет свои и попроще —
# проверяется, как панель зовёт кит и показывает его отказ. Ветку заглушка, как и кит, оставляет.
param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "каталога «$Path» не существует — удалять нечего" }

$tree = (git -C $Path rev-parse --show-toplevel 2>$null)
if (-not $tree) { throw "«$Path» не под git — это не рабочая копия проекта под китом" }
$tree = $tree.Replace('/', '\')
$main = (git -C $Path rev-parse --path-format=absolute --git-common-dir).Trim().Replace('/', '\')
if ($tree -ieq (Split-Path $main -Parent)) {
    throw "«$tree» — основная копия проекта, а не заведённая рядом: убирать её киту нечем"
}

$dirty = @(git -C $tree status --porcelain --untracked-files=all 2>$null | Where-Object { $_ })
if ($dirty.Count) {
    $named = (@($dirty | Select-Object -First 3) | ForEach-Object { $_.Substring(3) }) -join ', '
    if ($dirty.Count -gt 3) { $named += " и ещё $($dirty.Count - 3)" }
    throw "в копии «$tree» незакоммиченное: $named — сначала закоммитить"
}

$branch = (git -C $tree rev-parse --abbrev-ref HEAD 2>$null)
$out = git -C (Split-Path $main -Parent) worktree remove $tree 2>&1
if ($LASTEXITCODE -ne 0) { throw "git не убрал копию «$tree»: $(($out | Out-String).Trim())" }
"Рабочая копия удалена: $tree"
if ($branch -and $branch -ne 'HEAD') { "Ветка осталась:        $branch" }
'@

    $reference = Join-Path $Path 'reference\flow-stages.md'
    if ($Rules -and (Test-Path -LiteralPath $Rules)) {
        New-Item -ItemType Directory -Path (Split-Path $reference -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $Rules -Destination $reference -Force
    } else {
        Write-Utf8 $reference @'
# Флоу: сценарии и этапы

Заглушка кита: настоящей справки рядом не нашлось, и здесь только то, без чего переписывание этапа не начнётся.

## Этап

Этап — файл `flow/stages/<слаг>.md`. Заголовок файла — название этапа, под ним подряд пары `ключ: значение`,
после пустой строки — описание.

Ключи — закрытый перечень: `исполнитель` (обязателен), `помощники`, `выход` (обязателен), `пропуск`.
'@
    }
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

    $stub = @'
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
# Разговор по базе идёт живым процессом: реплики приходят строками, и весь ввод разом не читается.
$chat = $arguments -contains '--input-format'
# Текст оператора приходит в stdin в UTF-8: читаем поток сами, иначе консоль отдаст его
# в кодировке по умолчанию и русские буквы приедут мусором.
$stdinReader = if ([Console]::IsInputRedirected) {
    [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
} else { $null }
$stdin = if ($stdinReader -and -not $chat) { $stdinReader.ReadToEnd() } else { '' }

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
    # Настоящая фоновая сессия появляется в реестре живых, и панель по ней видит, что запуск
    # ещё идёт: без записи копия числилась бы свободной до самой памяти задачи.
    $dummy = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 86400')
    $session = [ordered]@{
        pid        = $dummy.Id
        cwd        = (Get-Location).Path
        entrypoint = 'cli'
        kind       = 'bg'
        jobId      = $id
        status     = 'busy'
        name       = "песочница drive $id"
        startedAt  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $file = Join-Path (Join-Path $root 'sessions') "$($dummy.Id).json"
    [IO.File]::WriteAllText($file, (([pscustomobject]$session) | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Write-Line "Session backgrounded · $id"
    exit 0
}

if ($mode -eq 'garbage') {
    Write-Line 'здесь должен был быть поток событий агента'
    Write-Line '{ это почти json, но нет'
    exit 0
}

# Переписка о флоу: панель зовёт агента с правилами формы сценария и этапа в системном промпте, первой репликой
# отдаёт флоу целиком, а ждёт слова и блоки правок «=== этап «…»», «=== новый этап», «=== сценарий «…»» и удаления.
# Подставной на первую реплику переспрашивает, на вторую предлагает правки: дописывает к выходу первого этапа слова
# просьбы, заводит этап заметок и ставит его в конец первого сценария; по слову «удали» убирает этап заметок.
$system = Get-Argument '--append-system-prompt'
if ($system -and $system -match 'правишь флоу проекта') {
    $notes = 'Заметки подставного агента'
    $stageTitle = $null; $stageFile = $null; $scenarioName = $null; $scenario = $null
    $wish = ''
    $turn = 0
    while ($null -ne ($line = $stdinReader.ReadLine())) {
        if (-not $line.Trim()) { continue }
        $said = try { ([string]($line | ConvertFrom-Json).message.content[0].text) -replace "`r`n", "`n" } catch { $line }
        $turn++
        Write-Step 'Read' @{ file_path = 'flow/scenarios.md' }
        Write-Step 'Glob' @{ pattern = 'flow/stages/*.md' }
        if ($mode -eq 'truncated') { exit 0 }

        # Первая реплика несёт флоу целиком: из неё берутся первый этап и первый сценарий.
        if ($said -match '(?s)^Просьба оператора:\n(.*?)\n\nСценарии \(flow/scenarios\.md\):\n(.*?)\n\nЭтапы \(flow/stages/\):(.*?)\n\nЗадачи в работе:') {
            $wish = $Matches[1].Trim()
            $scenarios = $Matches[2]
            $stages = $Matches[3]
            $stageMatch = [regex]::Match($stages, '(?ms)^=== [^\n]*\n(# ([^\n]*)\n.*?)(?=\n\n=== |\z)')
            if ($stageMatch.Success) { $stageFile = $stageMatch.Groups[1].Value.TrimEnd(); $stageTitle = $stageMatch.Groups[2].Value.Trim() }
            $scenarioMatch = [regex]::Match($scenarios, '(?ms)^## ([^\n]*)\n.*?(?=^## |\z)')
            if ($scenarioMatch.Success) { $scenario = $scenarioMatch.Value.TrimEnd(); $scenarioName = $scenarioMatch.Groups[1].Value.Trim() }
            $said = $wish
        }

        if ($turn -eq 1) {
            $about = if ($stageTitle) { "в этапе «$stageTitle»" } else { 'во флоу' }
            Write-Result "Подставной агент песочницы переспрашивает: что именно поправить $about по просьбе «$said»? Ответьте что угодно — следующей репликой он предложит правки."
            continue
        }

        if ($said -match 'удали') {
            $blocks = @("Убрал этап заметок.", "=== удалить этап «$notes»")
            if ($scenario) { $blocks += "=== сценарий «$scenarioName»`n$scenario" }
            Write-Result ($blocks -join "`n")
            continue
        }

        if ($turn -eq 2) {
            $blocks = @("Предлагаю правки по просьбе «$wish» и уточнению «$($said.Trim())».")
            if ($stageFile) {
                $rewritten = $stageFile -replace '(?m)^выход:\s*(.*)$', "выход: `$1 — по просьбе «$wish»"
                $blocks += "=== этап «$stageTitle»`n$rewritten"
            }
            $blocks += "=== новый этап`n# $notes`n`nисполнитель: оператор`nвыход: заметка по просьбе «$wish»`n`n1. Написано подставным агентом песочницы: настоящего этапа здесь нет."
            if ($scenario) {
                $next = ([regex]::Matches($scenario, '(?m)^\s*\d+\.')).Count + 1
                $blocks += "=== сценарий «$scenarioName»`n$scenario`n$next. [$notes](stages/notes.md)"
            }
            Write-Result ($blocks -join "`n")
            continue
        }

        Write-Result "Реплика $turn — «$($said.Trim())». Правки прежние: они на вкладке «Изменения». Скажите «удали», и подставной агент уберёт этап заметок."
    }
    exit 0
}

$baseDir = Get-Argument '--add-dir'

# Разговор о бэклоге: реплики приходят строками stream-json. Новую запись агент дописывает и коммитит,
# изменение, удаление и объединение только предлагает блоками ~~~backlog — пишет их панель по «Сохранить».
# Запись, названная без номера, уточняется вопросом; «да» в ответ делает прежнюю просьбу с этой записью.
if ($baseDir) {
    $backlog = Join-Path $baseDir 'backlog.md'
    $asked = $null
    function Get-Block([string]$Text, [string]$Number) {
        $found = [regex]::Match($Text, "(?ms)^## $([regex]::Escape($Number))\s.*?(?=^## |\z)")
        if ($found.Success) { return $found.Value.TrimEnd() } else { return $null }
    }
    while ($null -ne ($line = $stdinReader.ReadLine())) {
        if (-not $line.Trim()) { continue }
        $said = try { ([string]($line | ConvertFrom-Json).message.content[0].text).Trim() } catch { $line.Trim() }
        # Панель зовёт навык кита первой репликой и называет запись, от которой открыт разговор.
        $said = ($said -replace '^\s*/[\w:-]+\s*', '').Trim()
        $about = if ($said -match '^Про запись (\S+):\s*') { $Matches[1] } else { $null }
        $said = ($said -replace '^Про запись \S+:\s*', '').Trim()
        if (-not $said) { $said = 'Оператор ничего не сказал.' }

        Write-Step 'Read' @{ file_path = $backlog }
        if ($mode -eq 'truncated') { exit 0 }
        $text = [IO.File]::ReadAllText($backlog)
        $letters, $number = if ($text -match '(?m)^следующий номер:\s*([A-Z][A-Z0-9]*)-(\d+)\s*$') { $Matches[1], [int]$Matches[2] } else { 'B', 1 }

        if ($asked -and $said -match '^да\b') { $said = $asked.Said; $numbers = @($asked.Number) }
        else { $numbers = @([regex]::Matches($said, "\b$letters-\d+\b") | ForEach-Object Value) }
        if ($about -and $numbers.Count -eq 0) { $numbers = @($about) }
        $asked = $null
        $verb = if ($said -match 'объедин') { 'merge' } elseif ($said -match 'удал') { 'delete' } elseif ($said -match 'измен|поправ|переимен|перепиш') { 'change' } else { $null }

        if ($verb -and $numbers.Count -eq 0) {
            $first = [regex]::Match($text, "(?m)^## ($letters-\d+)\s+(.+)$")
            if ($first.Success) {
                $asked = @{ Said = $said; Number = $first.Groups[1].Value }
                Write-Result "Нашёл запись $($first.Groups[1].Value) «$($first.Groups[2].Value.Trim())». Та ли это? Ответьте «да» или назовите номер."
                continue
            }
        }

        if ($verb) {
            $blocks = @()
            $missing = $numbers | Where-Object { -not (Get-Block $text $_) }
            if ($missing) {
                Write-Result "Записи $($missing -join ', ') в бэклоге нет."
                continue
            }
            if ($verb -eq 'merge' -and $numbers.Count -ge 2) {
                $keep, $gone = $numbers[0], $numbers[1]
                $keptBlock = Get-Block $text $keep
                $goneTitle = ((Get-Block $text $gone) -split "`n")[0] -replace "^## $gone\s+", ''
                $keptLines = $keptBlock -split "`n"
                $keptLines[0] = "$($keptLines[0].TrimEnd()) и $($goneTitle.Trim())"
                $blocks += "~~~backlog`nизменить $keep`n$($keptLines -join "`n")`n~~~"
                $blocks += "~~~backlog`nудалить $gone в $keep`n~~~"
                $reply = "Объединю $gone в $keep."
            } elseif ($verb -eq 'delete') {
                $blocks += $numbers | ForEach-Object { "~~~backlog`nудалить $_`n~~~" }
                $reply = "Удалю $($numbers -join ', ')."
            } else {
                foreach ($n in $numbers) {
                    $lines = (Get-Block $text $n) -split "`n"
                    $lines[0] = "$($lines[0].TrimEnd()) (изменено)"
                    $blocks += "~~~backlog`nизменить $n`n$($lines -join "`n")`n~~~"
                }
                $reply = "Изменю $($numbers -join ', ')."
            }
            Write-Result ("$reply Сохраните, если так.`n`n" + ($blocks -join "`n"))
            continue
        }

        # Приложенные файлы панель уже положила в artifacts/ и назвала абзацем в конце реплики: навык вписывает их
        # в «Артефакты» записи и коммитит вместе с ней.
        $attached = @([regex]::Matches($said, 'artifacts/[^\s,]+') | ForEach-Object { $_.Value.TrimEnd('.') })
        $said = ($said -split "`n`nОператор приложил файлы")[0]
        # Буквы номеров у каждой базы свои: их держит счётчик, как у кита. Заголовок записи — сам текст.
        $title = ($said -split "`n")[0]
        if ($title.Length -gt 70) { $title = $title.Substring(0, 70) }
        $artifacts = if ($attached.Count -gt 0) {
            "`n`n### Артефакты`n" + (($attached | ForEach-Object { "- приложено из панели: $_" }) -join "`n")
        } else { '' }
        $text = $text -replace "(?m)^следующий номер:\s*[A-Z][A-Z0-9]*-\d+\s*$", "следующий номер: $letters-$($number + 1)"
        $text = $text.TrimEnd() + "`n`n## $letters-$number $title`n`n$said$artifacts`n`n### Агенту`n- записано подставным агентом песочницы`n"
        [IO.File]::WriteAllText($backlog, $text, [Text.UTF8Encoding]::new($false))
        Write-Step 'Edit' @{ file_path = $backlog }
        if ($attached.Count -gt 0) { git -C $baseDir commit -q -m 'Записано из панели' -- backlog.md artifacts }
        else { git -C $baseDir commit -q -m 'Записано из панели' -- backlog.md }
        Write-Result "Записал $letters-$number."
    }
    exit 0
}

# Разговор по базе: агент работает в каталоге базы, только читает и отвечает на каждую реплику,
# пока панель не закроет ввод. Реплика приходит строкой stream-json.
$product = Join-Path (Get-Location).Path 'product.md'
if (-not $chat) {
    Write-Step 'Read' @{ file_path = $product }
    Write-Step 'Grep' @{ pattern = 'песочница' }
    if ($mode -eq 'truncated') { exit 0 }
    Write-Result "Подставной агент песочницы отвечает на «$($stdin.Trim())»: настоящего ответа здесь нет и быть не может, зато видно, как панель показывает ход работы и итог."
    exit 0
}

$said = @()
while ($null -ne ($line = $stdinReader.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $text = try { ([string]($line | ConvertFrom-Json).message.content[0].text).Trim() } catch { $line.Trim() }
    $said += $text
    Write-Step 'Read' @{ file_path = $product }
    Write-Step 'Grep' @{ pattern = 'песочница' }
    if ($mode -eq 'truncated') { exit 0 }
    $answer = if ($said.Count -eq 1) {
        "Подставной агент песочницы отвечает на «$text»: настоящего ответа здесь нет и быть не может, зато видно, как панель показывает ход работы и итог."
    } else {
        "Реплика $($said.Count) — «$text». Прошлые реплики я помню: $($said[0..($said.Count - 2)] -join ' · ')."
    }
    Write-Result $answer
}
exit 0
'@
    Write-Utf8 (Join-Path $Path 'claude-stub.ps1') $stub
}
