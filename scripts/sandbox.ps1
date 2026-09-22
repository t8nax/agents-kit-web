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

. (Join-Path $PSScriptRoot 'fixtures.ps1')

function Stop-OldDummies {
    if (-not (Test-Path -LiteralPath $state)) { return }
    try { $old = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json } catch { return }
    foreach ($dummy in @($old.dummies)) {
        $process = Get-Process -Id $dummy -ErrorAction Ignore
        # Номера процессов Windows переиспользует: гасим только свою пустышку.
        if ($process -and $process.ProcessName -eq 'pwsh') { Stop-Process -Id $dummy -Force -ErrorAction Ignore }
    }
}

# --- содержимое баз ----------------------------------------------------------------------

# Исполнители базы: их зовёт флоу песочницы, и оттуда же кит развозит их по копиям. Кладутся
# в каждую базу до первого коммита — в живой базе они тоже лежат в истории.
function New-Agents([string]$Path) {
    Write-Utf8 (Join-Path $Path 'agents\reviewer.md') @"
---
name: reviewer
description: Вычитывает дифф ветки задачи и возвращает замечания.
tools: Read, Grep, Glob
model: opus
---

Ты читаешь дифф ветки целиком и возвращаешь замечания списком.
"@
    Write-Utf8 (Join-Path $Path 'agents\doc-writer.md') @"
---
name: doc-writer
description: Пишет документацию по коду.
---

Ты пишешь документацию по коду.
"@
}

# Флоу в форме кита: список флоу в flow\flow.md и стадии по файлу в flow\stages. Флоу два — «полный»
# и «мелкий» из общих стадий: на них видно, что стадия правится один раз, а возвраты у каждого флоу свои.
function New-Flow([string]$Path) {
    Write-Utf8 (Join-Path $Path 'flow\flow.md') @'
# Песочница — флоу

Задачу из бэклога без слов оператора брать по наименьшему номеру.

## полный
когда: новая возможность или правка в нескольких местах
1. [Критерий](stages/criterion.md)
2. [Ветка](stages/branch.md)
3. [Реализация](stages/implementation.md)
4. [Ревью](stages/review.md)
   - возврат: блокер или мажор — стадия «Реализация»
5. [Сборка](stages/build.md)
6. [Приёмка](stages/acceptance.md)
   - возврат: замечания — стадия «Реализация»
7. [Мерж](stages/merge.md)

## мелкий
когда: правка в одном месте, без новых решений
1. [Ветка](stages/branch.md)
2. [Реализация](stages/implementation.md)
3. [Приёмка](stages/acceptance.md)
4. [Мерж](stages/merge.md)
'@
    $stages = [ordered]@{
        criterion      = @'
# Критерий

исполнитель: оркестратор
выход: критерий закрытия в памяти и ответ оператора, что критерий подтверждён

1. Написать критерий до первой строчки кода.
2. Вынести его оператору вопросом в памяти.
'@
        branch         = @'
# Ветка

исполнитель: оркестратор
выход: имя ветки в строке «ветка» памяти

- Завести ветку задачи от обновлённого dev.
'@
        implementation = @'
# Реализация

исполнитель: оркестратор
помощники: reviewer, doc-writer
выход: sha коммитов ветки и зелёные прогоны проверок в памяти

- Вести работу шагами, каждый со своей проверкой.
'@
        review         = @'
# Ревью

исполнитель: reviewer
выход: вердикт по sha проверенного коммита
пропуск: правка не трогает код

- Дать ревьюеру ветку задачи и базу сравнения.
'@
        build          = @'
# Сборка

исполнитель: builder
выход: зелёная сборка в памяти

- Собрать то, что правили.
'@
        acceptance     = @'
# Приёмка

исполнитель: оператор
выход: ответ оператора в памяти — «принято» или список замечаний
пропуск: правка не меняет ни вида, ни поведения панели

- Показать оператору, что смотреть.
'@
        merge          = @'
# Мерж

исполнитель: оркестратор
выход: «смержено и запушено: <sha в dev>, ветка удалена» в памяти

- Мержить только после «принято».
'@
    }
    foreach ($slug in $stages.Keys) {
        Write-Utf8 (Join-Path $Path "flow\stages\$slug.md") $stages[$slug]
    }
}

# Бэклог базы. Буквы номеров у проекта свои: $Orders даёт бэклог с буквами «ORD» — с записью
# чужими буквами, которую кит перенумерует, и с записью без номера.
function New-Backlog([string]$Path, [switch]$Orders) {
    if ($Orders) {
        Write-Utf8 (Join-Path $Path 'backlog.md') @'
# Заказы — бэклог

следующий номер: ORD-18
поля: приоритет, тип

## ORD-15 Повторная оплата создаёт второй заказ

приоритет: блокер
тип: баг

Покупатель жмёт «Оплатить» второй раз, пока первая оплата идёт, и заказов становится два.

## ORD-14 Выгрузка заказов за период в CSV

приоритет: высокий
тип: фича

Бухгалтерии нужна выгрузка за месяц, сейчас её собирают руками.

## ORD-17 Фильтр списка заказов по статусу доставки

приоритет: средний
тип: фича

## B-7 Таймаут платёжного шлюза не попадает в лог

приоритет: низкий
тип: баг

Запись перенесли из другого проекта вместе с его номером: кит её перенумерует.

## Разобраться с часовыми поясами в отчётах

приоритет: низкий
тип: фича

Дописано руками, без номера.
'@
        return
    }
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

function New-Memory([string]$Path, [string]$Copy, [string]$Branch, [switch]$Crlf, [switch]$NoAnswerKey, [switch]$TwoQuestions, [switch]$ThreeQuestions,
    [switch]$Artifacts, [switch]$OldDesign, [string]$Task = 'B-7 Опрос копий не должен мешать работе') {
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
    if ($TwoQuestions -or $ThreeQuestions) {
        $question += @'

### Гасить ли панель на ночь?
Панель работает всегда, хотя ночью её никто не открывает.

- вариант: гасить по расписанию — утром её надо будить руками
- вариант: не гасить — как сейчас

ответ:
'@
    }
    # Третий вопрос — без вариантов: на нём видно поле ответа без списка выбора.
    if ($ThreeQuestions) {
        $question += @'

### Куда складывать журнал опроса?
Сейчас журнал опроса пишется рядом с панелью и растёт без предела. Его можно класть в `%LOCALAPPDATA%` или в папку, которую назовёте.

- журнал за неделю — около 40 МБ;
- старые журналы никто не читает.

ответ:
'@
    }

    # Артефакты по форме кита: ссылка открывается вкладкой браузера, путь к файлу — в VS Code.
    $artifactsBlock = if ($Artifacts) {
        # Файл лежит вне копии: в копии он был бы неотслеживаемой правкой её git. Щелчок в окне ответа
        # открывает его в VS Code.
        $spec = Join-Path $Root 'files\export-spec.md'
        Write-Utf8 $spec "# Спецификация выгрузки заказов`n`nВыдуманный файл песочницы: артефакт задачи ORD-12.`n"
        "`n## Артефакты`n- макет выгрузки: https://claude.ai/artifact/SandboxMock1`n- спецификация выгрузки: $spec`n"
    } else { '' }
    # Макет по-старому, подразделом критериев: окно его не показывает ни артефактом, ни критерием.
    $designBlock = if ($OldDesign) { "`n### Дизайн`nМакет: https://claude.ai/artifact/SandboxOld1`n" } else { '' }

    $text = @"
# $Task

рабочая копия: $Copy
ветка: $Branch
флоу: мелкий
Решения: нет

## Критерии закрытия

### 1. Таблица копий обновляется без рывков
Оператор открывает раздел «Копии» и видит, что строки обновляются, а страница при этом не дёргается.

### Не входит
Переделка вида таблицы.
$designBlock$artifactsBlock$question

## Агенту

### Критерии
- 1. проверка: замер геометрии строк каждый кадр — где: e2e-прогон

### Вопросы
- «Переносить ли опрос копий на сервер?»: ответ решает, где живёт состояние опроса

### Факты
- Опрос идёт раз в три секунды.

### Флоу
- [x] 1. Ветка — выход: feat/polling от dev
- [ ] 2. Реализация
- [ ] 3. Приёмка
- [ ] 4. Мерж

### Шаги
- [x] Замерить, сколько длится опрос — результат: 40 мс на копию — проверен: вывод прогона
- [ ] Свести опрос к одному запросу
"@
    Write-Utf8 $Path $text -Crlf:$Crlf
}

# Выдуманная база знаний: та же раскладка, что у настоящей, — панель читает её теми же правилами.
function New-Base([string]$Path, [string]$Title, [string[]]$Copies, [switch]$NoProduct, [switch]$BrokenJson, [switch]$FlowUncommitted,
    [switch]$Orders) {
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
    New-Agents $Path
    New-Backlog $Path -Orders:$Orders
    New-Item -ItemType Directory -Path (Join-Path $Path 'work') -Force | Out-Null
    Write-Utf8 (Join-Path $Path '.gitignore') "local/`n"
    Add-Commit $Path 'Каркас базы песочницы'
    # Флоу, которого нет в истории: список флоу панель коммитит без git add, и такой файл ей не закоммитить.
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
# Правила формы стадии заглушка берёт у установленного кита — с ними и настоящий агент (-RealAgent) пишет
# стадии как в жизни. Путь к киту — из списка баз оператора, только на чтение; нет его — место по умолчанию.
$installedKit = try { (Get-Content -LiteralPath (Join-Path $env:APPDATA 'agents-kit-web\bases.json') -Raw | ConvertFrom-Json).kit } catch { $null }
if (-not $installedKit) { $installedKit = Join-Path $HOME '.claude\skills\agents-kit' }
New-Kit $kitDir -Rules (Join-Path $installedKit 'reference\flow-stages.md')
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
# Копия, где задача уже закончилась: памяти у неё нет, и сессия в ней стоит одна — на ней
# и видно, как панель гасит отработавшую сессию, ничего вокруг не задевая.
$goodDone = Join-Path $copiesDir 'house-done'
git -C $goodCopy worktree add -b feat/done $goodDone --quiet

New-Base $goodBase 'Дом' @($goodCopy)
# Три вопроса разом: с рекомендованным вариантом, с вариантами без рекомендованного и без вариантов —
# на них видна лента окна ответа, пропуск, правка ответа и отмена отправки.
New-Memory (Join-Path $goodBase 'work\house-task.md') $goodWorktree 'feat/polling' -ThreeQuestions
Add-Commit $goodBase 'Память задачи'
$bases.Add($goodBase)
foreach ($copy in @($goodCopy, $goodWorktree, $goodDone)) {
    $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $goodBase })
}
$findings.Add([pscustomobject]@{ base = $goodBase; findings = @() })

# Проект со своими буквами номеров — «ORD», а не «B»: панель узнаёт номер по буквам проекта.
# В одной копии идёт задача ORD-12, в другой — задача не из бэклога, чей заголовок начат словом
# «UTF-8»: номером оно не становится. Третья копия свободна — в неё берут записи бэклога.
$ordersCopy = Join-Path $copiesDir 'orders'
$ordersBase = Join-Path $basesDir 'orders-knowledge'
New-Repo $ordersCopy
Write-Utf8 (Join-Path $ordersCopy 'README.md') "# Заказы`n`nВыдуманный проект песочницы.`n"
Add-Commit $ordersCopy 'Первый коммит'
$ordersTask = Join-Path $copiesDir 'orders-export'
git -C $ordersCopy worktree add -b feat/ord-12-export $ordersTask --quiet
$ordersUtf = Join-Path $copiesDir 'orders-utf'
git -C $ordersCopy worktree add -b fix/utf-names $ordersUtf --quiet

New-Base $ordersBase 'Заказы' @($ordersCopy) -Orders
New-Memory (Join-Path $ordersBase 'work\orders-export.md') $ordersTask 'feat/ord-12-export' -Task 'ORD-12 Выгрузка заказов за период' -Artifacts
New-Memory (Join-Path $ordersBase 'work\orders-utf.md') $ordersUtf 'fix/utf-names' -Task 'UTF-8 в именах файлов ломает выгрузку' -OldDesign
Add-Commit $ordersBase 'Памяти задач'
$bases.Add($ordersBase)
foreach ($copy in @($ordersCopy, $ordersTask, $ordersUtf)) {
    $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $ordersBase })
}
$findings.Add([pscustomobject]@{ base = $ordersBase; findings = @(
    [pscustomobject]@{ severity = 'FAIL'; file = 'backlog.md'; message = 'номер чужими буквами: B-7' }) })

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
    [pscustomobject]@{ severity = 'WARN'; file = 'flow/flow.md'; message = 'флоу не в истории git' }) })

# Исполнитель, заведённый «оператором» прямо в базе и мимо панели: в разделе он виден наравне
# с остальными, хотя панель его не заводила.
Write-Utf8 (Join-Path $quirksBase 'agents\spec-writer.md') @"
---
name: spec-writer
description: Пишет спеку экрана по разговору с оператором.
---

Ты пишешь спеку экрана.
"@

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
    # Такую панель гасит сама, и в песочнице видно, как её строка уходит из перечня. Стоит она
    # в копии, где сессий больше нет: иначе рядом остаётся чужая строка той же копии.
    $finished = Start-Dummy
    $dummies.Add($finished)
    Write-Session $sessionsDir $finished $goodDone @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'f1e2d3c4'; status = 'idle' }
    # Ту самую сессию задачи копии панель знает только по своему запуску — отсюда и эта запись.
    Write-Json (Join-Path $panelDir 'task-sessions.json') ([pscustomobject]@{
            sessions = @([pscustomobject]@{ copy = $goodDone; session = 'f1e2d3c4' }) })
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
