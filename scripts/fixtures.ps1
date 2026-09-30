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
# $Layout — справка кита о раскладке базы (reference/base-layout.md): из её раздела «Трекер» — правила описания трекера.
function New-Kit([string]$Path, [string]$Rules, [string]$Layout) {
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

    Write-Utf8 (Join-Path $scripts 'sync.ps1') @'
# Заглушка кита: сведение базы с сервером (B-293). Сервера у баз песочницы нет — настоящий кит ответил бы
# «сводить не с чем». Режим читается на каждый вызов из sync-mode.txt корня песочницы:
#   ok         сведено (по умолчанию)
#   push-fail  забор проходит, отдача отказывает, как при чужом коммите на сервере
#   pull-fail  забор отказывает, как при незакоммиченной правке в базе
#   offline    сервер недоступен: код 2
# Вызовы пишутся в sync.log рядом со скриптами: по нему видно, что панель забрала базу до записи и отдала после.
param([string]$Path, [string]$Repo, [string]$Action)

Add-Content -LiteralPath (Join-Path $PSScriptRoot 'sync.log') -Value "$(Get-Date -Format s) $Action $Repo $Path" -Encoding utf8
$mode = 'ok'
$dir = $PSScriptRoot
while ($dir) {
    $candidate = Join-Path $dir 'sync-mode.txt'
    if (Test-Path -LiteralPath $candidate) { $mode = (Get-Content -LiteralPath $candidate -Raw).Trim().ToLowerInvariant(); break }
    $dir = Split-Path $dir -Parent
}
switch ($mode) {
    'offline' { Write-Host 'remote базы недоступен: заглушка кита так настроена — работа идёт с локальным, отдастся при следующем сведении'; exit 2 }
    'pull-fail' { Write-Host 'с remote базы не забрано — в базе незакоммиченная правка: product.md. Её закоммитит сессия, которая её ведёт; забрать при следующем сведении'; exit 1 }
    'push-fail' {
        if ($Action -eq 'Push') { Write-Host "на remote базы не отдано — git: ! [rejected] main -> main (fetch first); отдастся при следующем сведении"; exit 1 }
    }
}
if ($Action -eq 'Push') { Write-Host 'на remote базы отдано коммитов: 1' } else { Write-Host 'с remote базы забирать нечего' }
exit 0
'@

    # Правила описания трекера — раздел «Трекер» справки кита о раскладке базы: из него панель подаёт их
    # Чудо-Юдо в окне «Трекер проекта». Берутся у установленного кита, как справка о флоу.
    $layout = Join-Path $Path 'reference\base-layout.md'
    if ($Layout -and (Test-Path -LiteralPath $Layout)) {
        New-Item -ItemType Directory -Path (Split-Path $layout -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $Layout -Destination $layout -Force
    } else {
        Write-Utf8 $layout @'
# Раскладка базы

## Трекер

Заглушка кита: настоящей справки рядом не нашлось. `tracker.md` — заголовок `# <проект> — трекер` и разделы
`## Где задачи` (строки `трекер:`, `сервер:`, `проект:`, пустая строка и слова), `## Показ бэклога`,
`## Взятие задачи`, `## Задача закрыта`, `## Вынос записи бэклога` — каждый непустой.
'@
    }

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
if ($system -and $system -match 'правишь (его )?флоу проекта') {
    $notes = 'Заметки подставного агента'
    $stageTitle = $null; $stageFile = $null; $scenarioName = $null; $scenario = $null
    $wish = ''
    $turn = 0
    $reworks = 0
    while ($null -ne ($line = $stdinReader.ReadLine())) {
        if (-not $line.Trim()) { continue }
        $said = try { ([string]($line | ConvertFrom-Json).message.content[0].text) -replace "`r`n", "`n" } catch { $line }
        # Просьба панели дописать ответ — не реплика оператора: счёт реплик она не двигает.
        if ($said -notmatch '^Панель не приняла твой ответ') { $turn++ }
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

        # Неполный этап: по слову «неполный» агент заводит этап черновика без выхода, и панель возвращает ответ
        # на доработку; дописывает он его сразу, а со словом «дважды» — снова без выхода, и панель показывает ошибку.
        $draft = 'Черновик подставного агента'
        $incomplete = "Завёл этап черновика, а выход забыл.`n=== новый этап`n# $draft`n`nисполнитель: оператор`n`n1. Написано подставным агентом песочницы."
        if ($said -match '^Панель не приняла твой ответ') {
            if ($reworks -gt 0) {
                $reworks--
                Write-Result $incomplete
            } else {
                Write-Result "Дописал выход.`n=== новый этап`n# $draft`n`nисполнитель: оператор`nвыход: черновик по просьбе оператора`n`n1. Написано подставным агентом песочницы."
            }
            continue
        }
        if ($said -match 'неполн') {
            $reworks = if ($said -match 'дважды') { 1 } else { 0 }
            Write-Result $incomplete
            continue
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

# Переписка об описании трекера (B-293): каждая реплика несёт описание, каким оно стоит в окне, а ждёт панель слов
# и блока «=== описание» с tracker.md целиком. Подставной на первую реплику переспрашивает, на вторую предлагает
# описание: пустое заводит GitHub-трекером sandbox/tracker, имеющееся дополняет разделом «Взятие задачи» словами
# просьбы. По слову «неполное» предлагает описание с пустым разделом — панель вернёт его на доработку.
if ($system -and $system -match 'пишешь описание трекера проекта') {
    $project = if ($system -match 'трекера проекта «([^»]*)»') { $Matches[1] } else { 'Проект' }
    $turn = 0
    $wish = ''
    $broken = $false
    while ($null -ne ($line = $stdinReader.ReadLine())) {
        if (-not $line.Trim()) { continue }
        $said = try { ([string]($line | ConvertFrom-Json).message.content[0].text) -replace "`r`n", "`n" } catch { $line }
        Write-Step 'Read' @{ file_path = 'tracker.md' }
        if ($mode -eq 'truncated') { exit 0 }
        $current = if ($said -match '(?s)\n\nОписание в окне сейчас:\n(.*)$') { $Matches[1] } else { '' }
        $words = ($said -replace '(?s)\n\nОписание в окне сейчас:\n.*$', '') -replace '^(Просьба оператора|Оператор):\n', ''
        function Get-Section([string]$Name) {
            $m = [regex]::Match($current, "(?ms)^## $([regex]::Escape($Name))\s*\n(.*?)(?=^## |\z)")
            if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
        }
        function Get-Key([string]$Name) {
            $m = [regex]::Match($current, "(?m)^$([regex]::Escape($Name)):\s*(.*)$")
            if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
        }
        $closedText = 'Ничего: задачу закрывает мерж.'
        if ($said -match '^Панель не приняла твой ответ') {
            $broken = $false
        } else {
            $turn++
            if ($turn -eq 1) { $wish = $words.Trim() }
            if ($words -match 'неполн') { $broken = $true }
            if ($turn -eq 1 -and -not $broken) {
                Write-Result "Подставной агент песочницы переспрашивает: что ещё записать в описание трекера по просьбе «$wish»? Ответьте что угодно — следующей репликой он предложит описание."
                continue
            }
        }
        $empty = $current -match '^пусто'
        $tracker = if ($empty -or -not (Get-Key 'трекер')) { 'GitHub' } else { Get-Key 'трекер' }
        $server = if ($empty -or -not (Get-Key 'сервер')) { 'https://github.com' } else { Get-Key 'сервер' }
        $proj = if ($empty -or -not (Get-Key 'проект')) { 'sandbox/tracker' } else { Get-Key 'проект' }
        $whereText = (Get-Section 'Где задачи') -replace '(?m)^(трекер|сервер|проект):.*\n?', ''
        if (-not $whereText.Trim()) { $whereText = 'Ходить программой gh.' }
        $backlogText = if (Get-Section 'Показ бэклога') { Get-Section 'Показ бэклога' } else { 'Открытые задачи, назначенные на меня.' }
        $takeText = if (Get-Section 'Взятие задачи') { Get-Section 'Взятие задачи' } else { 'Назначить на себя.' }
        $takeText = "$takeText Уточнено подставным агентом по просьбе «$wish»."
        $moveText = if (Get-Section 'Вынос записи бэклога') { Get-Section 'Вынос записи бэклога' } else { "Новая задача в $proj без меток." }
        if (-not $broken) { $closedText = if (Get-Section 'Задача закрыта') { Get-Section 'Задача закрыта' } else { $closedText } } else { $closedText = '' }
        $file = "# $project — трекер`n`n## Где задачи`n`nтрекер: $tracker`nсервер: $server`nпроект: $proj`n`n$($whereText.Trim())`n`n## Показ бэклога`n`n$backlogText`n`n## Взятие задачи`n`n$takeText`n`n## Задача закрыта`n`n$closedText`n`n## Вынос записи бэклога`n`n$moveText`n"
        $lead = if ($broken) { 'Предлагаю описание, раздел «Задача закрыта» забыл.' } else { "Предлагаю описание трекера по просьбе «$wish»." }
        Write-Result "$lead`n`n=== описание`n$file"
    }
    exit 0
}

# Переписка об исполнителе (B-320): каждая реплика несёт поля окна, а ждёт панель слов и блока «=== исполнитель»
# с файлом субагента целиком. Подставной на первую реплику переспрашивает, на вторую предлагает исполнителя: пустое
# окно заводит sandbox-helper, заполненное дополняет описание словами просьбы; дальше дописывает к описанию каждую
# реплику. По слову «неполный» предлагает исполнителя без имени — панель вернёт его на доработку. Разговор идёт
# с --add-dir базы, поэтому ветка стоит раньше разговора о бэклоге: тот пишет в backlog.md.
if ($system -and $system -match 'пишешь исполнителя') {
    $editing = $system -match 'правит заведённого исполнителя'
    $turn = 0
    $wish = ''
    $proposed = $null
    $broken = $false
    while ($null -ne ($line = $stdinReader.ReadLine())) {
        if (-not $line.Trim()) { continue }
        $said = try { ([string]($line | ConvertFrom-Json).message.content[0].text) -replace "`r`n", "`n" } catch { $line }
        Write-Step 'Glob' @{ pattern = 'agents/*.md' }
        if ($mode -eq 'truncated') { exit 0 }
        $words = (($said -split "`n`n")[0]) -replace '^(Просьба оператора|Оператор):\n', ''
        $window = if ($said -match '(?s)в окне сейчас:\n(.*?)(?:\n\nТвоё последнее предложение|\z)') { $Matches[1] } else { '' }
        $pending = if ($said -match '(?s)\n\nТвоё последнее предложение[^\n]*\n[^\n]*\n(.*)$') { $Matches[1] } else { '' }
        function Get-Key([string]$Text, [string]$Name) {
            $m = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name)):\s*(.*)$")
            if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
        }
        function Get-Prompt([string]$Text) {
            $m = [regex]::Match($Text, '(?s)^---\n.*?\n---\n\n?(.*)$')
            if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return '' }
        }
        if ($said -match '^Панель не приняла твой ответ') {
            $broken = $false
        } else {
            $turn++
            if ($turn -eq 1) { $wish = $words.Trim() }
            if ($words -match 'неполн') { $broken = $true }
            if ($turn -eq 1 -and -not $broken) {
                Write-Result "Подставной агент песочницы переспрашивает: что ещё должен уметь исполнитель по просьбе «$wish»? Ответьте что угодно — следующей репликой он предложит исполнителя."
                continue
            }
        }
        # Основа — прошлое предложение, если оно было, иначе поля окна.
        $basis = if ($pending) { $pending } elseif ($window -notmatch '^пусто') { $window } else { '' }
        $name = if (Get-Key $basis 'name') { Get-Key $basis 'name' } else { 'sandbox-helper' }
        $description = if (Get-Key $basis 'description') { Get-Key $basis 'description' } else { "Помогает по просьбе «$wish»." }
        if ($turn -ge 2 -and -not ($said -match '^Панель не приняла')) { $description = "$description Уточнено: $($words.Trim())." }
        $prompt = if (Get-Prompt $basis) { Get-Prompt $basis } else { "Ты — исполнитель песочницы. Делаешь то, о чём просил оператор: $wish." }
        $header = if ($broken) { "---`ndescription: $description`n---" } else { "---`nname: $name`ndescription: $description`nmodel: sonnet`n---" }
        $lead = if ($broken) { 'Предлагаю исполнителя, имя забыл.' } elseif ($editing) { "Переписал исполнителя $name." } else { "Предлагаю исполнителя $name." }
        Write-Result "$lead`n`n=== исполнитель`n$header`n`n$prompt`n"
    }
    exit 0
}

$baseDir = Get-Argument '--add-dir'

# Разговор о бэклоге: реплики приходят строками stream-json. Новую запись агент дописывает и коммитит,
# изменение, удаление и объединение только предлагает блоками ~~~backlog — пишет их панель по «Сохранить».
# Запись, названная без номера, уточняется вопросом; «да» в ответ делает прежнюю просьбу с этой записью.
# Бэклог — в личном репозитории оператора local\me базы, коммит — в его git.
if ($baseDir) {
    $personal = Join-Path $baseDir 'local\me'
    $backlog = Join-Path $personal 'backlog.md'
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
        $verb = if ($said -match 'в трекер') { 'track' } elseif ($said -match 'объедин') { 'merge' } elseif ($said -match 'удал') { 'delete' } elseif ($said -match 'измен|поправ|переимен|перепиш') { 'change' } else { $null }

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
            } elseif ($verb -eq 'track') {
                # Перенос в трекер (B-286): задачу заведёт панель по «Сохранить», агент только предлагает
                $blocks += $numbers | ForEach-Object { "~~~backlog`nв трекер $_`n~~~" }
                $reply = "Перенесу $($numbers -join ', ') в трекер."
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
        if ($attached.Count -gt 0) { git -C $personal commit -q -m 'Записано из панели' -- backlog.md artifacts }
        else { git -C $personal commit -q -m 'Записано из панели' -- backlog.md }
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

# --- подставной gh -----------------------------------------------------------------------

# Задачи трекера GitHub панель читает программой gh голым именем через PATH, и в песочнице её
# перехватывает свой gh.exe впереди PATH — всегда, и с -RealAgent тоже: настоящая gh пошла бы
# в GitHub под аккаунтом оператора. Обёртка — exe по той же причине, что у агента, и так же
# ничего не делает сама: зовёт gh-stub.ps1, отдав ему аргументы переменной окружения.
function New-GhStub([string]$Path) {
    Write-Utf8 (Join-Path $Path 'gh-shim.cs') @'
using System;
using System.Diagnostics;
using System.IO;

public static class GhShim
{
    public static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(typeof(GhShim).Assembly.Location);
        var start = new ProcessStartInfo("pwsh");
        start.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "gh-stub.ps1") + "\"";
        start.UseShellExecute = false;
        start.EnvironmentVariables["AKW_GH_ARGS"] = string.Join(((char)1).ToString(), args);
        using (var process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
'@

    $exe = Join-Path $Path 'gh.exe'
    $source = Join-Path $Path 'gh-shim.cs'
    & powershell.exe -NoProfile -NonInteractive -Command         "Add-Type -TypeDefinition (Get-Content -Raw '$source') -OutputAssembly '$exe' -OutputType ConsoleApplication" | Out-Null
    if (-not (Test-Path -LiteralPath $exe)) { throw "не собралась подмена gh: $exe" }

    $stub = @'
# Подставная gh: отвечает на «gh issue list --repo <репозиторий> …» задачами из gh-issues.json
# корня песочницы — объект «репозиторий: [задачи]»; репозитория там нет — как GitHub о чужом.
# Метки задачи — полем labels задачи в том же файле, как их отдаёт gh ([{ name, color }]); «gh label list --repo …»
# (перечень фильтра «Метки», B-305) отвечает метками репозитория из gh-labels.json — объект «репозиторий: [имена]».
# «gh issue create --repo … --title …» (перенос записи бэклога, B-286) дописывает задачу в тот же файл
# следующим номером — она назначена на оператора и видна в разделе после «Обновить», — кладёт описание,
# пришедшее во ввод, в gh-created\<номер>.md корня песочницы и печатает адрес задачи, как gh.
# Режим читается на каждый вызов из gh-mode.txt корня песочницы:
#   ok      задачи из gh-issues.json
#   login   gh не вошла в аккаунт GitHub
#   error   GitHub отвечает ошибкой сервера
#   slow    те же задачи через несколько секунд
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$root = Split-Path $PSScriptRoot -Parent
$modeFile = Join-Path $root 'gh-mode.txt'
$mode = if (Test-Path -LiteralPath $modeFile) { (Get-Content -LiteralPath $modeFile -Raw).Trim().ToLowerInvariant() } else { 'ok' }
if (-not $mode) { $mode = 'ok' }

$arguments = if ($env:AKW_GH_ARGS) { @($env:AKW_GH_ARGS -split [char]1) } else { @($args) }
$repo = $null
$title = $null
$search = $null
for ($i = 0; $i -lt $arguments.Count - 1; $i++) {
    if ($arguments[$i] -eq '--repo') { $repo = $arguments[$i + 1] }
    if ($arguments[$i] -eq '--title') { $title = $arguments[$i + 1] }
    if ($arguments[$i] -eq '--search') { $search = $arguments[$i + 1] }
}
$creating = $arguments.Count -ge 2 -and $arguments[0] -eq 'issue' -and $arguments[1] -eq 'create'
$labeling = $arguments.Count -ge 2 -and $arguments[0] -eq 'label' -and $arguments[1] -eq 'list'
# Панель пишет описание в UTF-8, как его читает настоящая gh; скрытый pwsh иначе читал бы ввод кодировкой консоли
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
# Описание приходит во ввод и читается до всякого ответа: иначе панель ждала бы, пока его заберут.
$body = if ($creating) { [Console]::In.ReadToEnd() } else { $null }

switch ($mode) {
    'login' {
        [Console]::Error.WriteLine('To get started with GitHub CLI, please run:  gh auth login')
        exit 4
    }
    'error' {
        [Console]::Error.WriteLine('HTTP 502: Bad Gateway (https://api.github.com/graphql)')
        exit 1
    }
    'slow' { Start-Sleep -Seconds 6 }
}

$issuesFile = Join-Path $root 'gh-issues.json'
$issues = Get-Content -LiteralPath $issuesFile -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $repo -or -not ($issues.PSObject.Properties.Name -contains $repo)) {
    [Console]::Error.WriteLine("GraphQL: Could not resolve to a Repository with the name '$repo'. (repository)")
    exit 1
}
if ($labeling) {
    $labelsFile = Join-Path $root 'gh-labels.json'
    $labels = if (Test-Path -LiteralPath $labelsFile) { Get-Content -LiteralPath $labelsFile -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
    $names = if ($labels -and ($labels.PSObject.Properties.Name -contains $repo)) { @($labels.$repo) } else { @() }
    $named = @($names | Sort-Object | ForEach-Object { [pscustomobject]@{ name = $_ } })
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $named -Depth 3 -Compress))
    exit 0
}
if ($creating) {
    $known = @($issues.$repo)
    # Measure-Object отдаёт дробное: «53.0» панель как номер задачи не прочитала бы
    $number = 1 + [int](@($known | ForEach-Object { [int]$_.number }) + 0 | Measure-Object -Maximum).Maximum
    $url = "https://github.com/$repo/issues/$number"
    $issues.$repo = @($known) + [pscustomobject]@{ number = $number; title = $title; url = $url }
    [IO.File]::WriteAllText($issuesFile, (ConvertTo-Json -InputObject $issues -Depth 6), [Text.UTF8Encoding]::new($false))
    $created = Join-Path $root 'gh-created'
    New-Item -ItemType Directory -Force -Path $created | Out-Null
    [IO.File]::WriteAllText((Join-Path $created "$number.md"), "# $title`n`n$body", [Text.UTF8Encoding]::new($false))
    [Console]::Out.WriteLine("`nCreating issue in $repo`n`n$url")
    exit 0
}
# Фильтр описания трекера (B-300) приходит в --search: «label:метка» — по меткам задачи, «milestone:этап» —
# по этапу, прочие слова — по заголовку. Поиск GitHub фильтр не отвергает: непонятное просто ничего не находит.
$list = @($issues.$repo)
# Панель передаёт фильтр в скобках.
if ($search -match '^\((.*)\)$') { $search = $Matches[1] }
if ($search) {
    foreach ($token in ($search -split '\s+' | Where-Object { $_ })) {
        $list = if ($token -like 'label:*') { @($list | Where-Object { @($_.labels | ForEach-Object { $_.name }) -contains $token.Substring(6) }) }
                elseif ($token -like 'milestone:*') { @($list | Where-Object { $_.milestone -eq $token.Substring(10) }) }
                else { @($list | Where-Object { $_.title -like "*$token*" }) }
    }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($list | Select-Object number, title, url, labels) -Depth 4 -Compress))
exit 0
'@
    Write-Utf8 (Join-Path $Path 'gh-stub.ps1') $stub
}

# Задачи YouTrack панель читает сама, по REST с ключом из «Настроек» (B-288), и в песочнице ей отвечает свой
# сервер на localhost — youtrack-stub.ps1 корня песочницы, его поднимает start-panel.ps1 рядом с API. Ключ
# сервер принимает один — perm:sandbox: его оператор вводит в разделе «Трекеры», в списке «Серверы трекеров».
function New-YouTrackStub([string]$Root, [int]$Port) {
    $stub = @'
# Подставной YouTrack песочницы на http://localhost:__PORT__/. Ключ — «perm:sandbox», владелец ключа — sandbox.operator.
# Проекты и их незакрытые задачи на владельце ключа — youtrack-issues.json корня песочницы: объект
# «проект: [задачи]», у задачи — номер, заголовок, состояние state и теги tags для фильтра (B-300). Новая задача
# (перенос записи бэклога) дописывается туда следующим номером, её описание — в youtrack-created\<номер>.md.
# Режим читается на каждый запрос из youtrack-mode.txt корня песочницы:
#   ok        отвечает как YouTrack
#   rejected  отклоняет любой ключ
#   error     отвечает ошибкой сервера
#   slow      отвечает через двадцать секунд — панель считает, что сервер не ответил
#   slow-create  читает как ok, а заведение задачи отвечает через семьдесят секунд — задача заводится, но панель
#             не дожидается ответа и пишет, что задача, возможно, заведена
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$issuesFile = Join-Path $root 'youtrack-issues.json'
$utf8 = [Text.UTF8Encoding]::new($false)

function Send($context, [int]$status, $body) {
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $body -Depth 6 -Compress))
    $context.Response.StatusCode = $status
    $context.Response.ContentType = 'application/json; charset=utf-8'
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:__PORT__/')
$listener.Start()
while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
        $modeFile = Join-Path $root 'youtrack-mode.txt'
        $mode = if (Test-Path -LiteralPath $modeFile) { (Get-Content -LiteralPath $modeFile -Raw).Trim().ToLowerInvariant() } else { 'ok' }
        if ($mode -eq 'slow') { Start-Sleep -Seconds 20 }
        if ($mode -eq 'error') { Send $context 503 @{ error = 'unavailable'; error_description = 'Сервер песочницы на обслуживании' }; continue }
        if ($mode -eq 'rejected' -or $context.Request.Headers['Authorization'] -ne 'Bearer perm:sandbox') {
            Send $context 401 @{ error = 'Unauthorized'; error_description = 'Unauthorized' }
            continue
        }
        $path = $context.Request.Url.AbsolutePath
        $issues = Get-Content -LiteralPath $issuesFile -Raw -Encoding utf8 | ConvertFrom-Json
        $projects = @($issues.PSObject.Properties.Name)
        if ($path.EndsWith('/api/users/me')) { Send $context 200 @{ login = 'sandbox.operator' }; continue }
        if ($path.EndsWith('/api/admin/projects')) {
            $i = 0
            Send $context 200 @($projects | ForEach-Object { $i++; @{ id = "0-$i"; shortName = $_ } })
            continue
        }
        if ($path.EndsWith('/api/issues') -and $context.Request.HttpMethod -eq 'GET') {
            $query = "$($context.Request.QueryString['query'])"
            $project = if ($query -match 'project: \{([^}]+)\}') { $Matches[1] } else { $null }
            $list = if ($project -and $projects -contains $project) { @($issues.$project) } else { @() }
            # Отбор описания трекера (B-300) — хвост после «#Unresolved»: поля State и tag значением или {значениями}
            # через запятую, прочие слова — по заголовку; другое поле YouTrack отвергает, как настоящий.
            $tail = if ($query -match '#Unresolved\s*(.*)$') { $Matches[1].Trim() } else { '' }
            # Панель дописывает фильтр в скобках: «… #Unresolved and (<фильтр>)».
            if ($tail -match '^and \((.*)\)$') { $tail = $Matches[1].Trim() }
            $pattern = '([A-Za-z]+):\s*((?:\{[^}]*\}(?:\s*,\s*\{[^}]*\})*)|\S+)'
            $unknown = @([regex]::Matches($tail, $pattern) | Where-Object { $_.Groups[1].Value -notin 'State', 'tag' } |
                ForEach-Object { $_.Groups[1].Value })
            if ($unknown.Count -gt 0) {
                Send $context 400 @{ error = 'bad_request'; error_description = "Unknown field `"$($unknown[0])`"" }
                continue
            }
            foreach ($match in [regex]::Matches($tail, $pattern)) {
                $wanted = @([regex]::Matches($match.Groups[2].Value, '\{([^}]*)\}') | ForEach-Object { $_.Groups[1].Value.Trim() })
                if ($wanted.Count -eq 0) { $wanted = @($match.Groups[2].Value) }
                $field = if ($match.Groups[1].Value -eq 'State') { 'state' } else { 'tags' }
                $list = @($list | Where-Object { @($_.$field | Where-Object { $_ -in $wanted }).Count -gt 0 })
            }
            foreach ($word in ([regex]::Replace($tail, $pattern, '') -split '\s+' | Where-Object { $_ })) {
                $list = @($list | Where-Object { $_.title -like "*$word*" })
            }
            Send $context 200 @($list | ForEach-Object { @{ idReadable = "$project-$($_.number)"; summary = $_.title } })
            continue
        }
        if ($path.EndsWith('/api/issues') -and $context.Request.HttpMethod -eq 'POST') {
            $reader = [IO.StreamReader]::new($context.Request.InputStream, $utf8)
            $payload = $reader.ReadToEnd() | ConvertFrom-Json
            $index = [int]($payload.project.id -replace '^0-', '') - 1
            $project = $projects[$index]
            $known = @($issues.$project)
            # Measure-Object отдаёт дробное: «53.0» панель как номер задачи не прочитала бы
            $number = 1 + [int](@($known | ForEach-Object { [int]$_.number }) + 0 | Measure-Object -Maximum).Maximum
            $issues.$project = @($known) + [pscustomobject]@{ number = $number; title = $payload.summary }
            [IO.File]::WriteAllText($issuesFile, (ConvertTo-Json -InputObject $issues -Depth 6), $utf8)
            $created = Join-Path $root 'youtrack-created'
            New-Item -ItemType Directory -Force -Path $created | Out-Null
            [IO.File]::WriteAllText((Join-Path $created "$project-$number.md"), "# $($payload.summary)`n`n$($payload.description)", $utf8)
            if ($mode -eq 'slow-create') { Start-Sleep -Seconds 70 }
            Send $context 200 @{ idReadable = "$project-$number"; summary = $payload.summary }
            continue
        }
        Send $context 404 @{ error = 'Not Found'; error_description = "Нет такого адреса: $path" }
    }
    catch {
        try { Send $context 500 @{ error = 'stub'; error_description = $_.Exception.Message } } catch { }
    }
}
'@
    Write-Utf8 (Join-Path $Root 'youtrack-stub.ps1') ($stub -replace '__PORT__', $Port)
}
