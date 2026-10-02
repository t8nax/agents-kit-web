<#
.SYNOPSIS
Собирает одноразовую песочницу: выдуманные базы знаний и рабочие копии, на которых панель
можно ломать, не задевая живые базы.

.DESCRIPTION
Каталог песочницы лежит вне репозитория панели и вне баз знаний и собирается заново каждым
запуском: что бы в нём ни испортили, откат — повторный запуск.

Песочница собирается под задачу: в неё кладутся только куски, названные ключом -Pieces, — здоровый
проект, проект со своими буквами номеров, каждая нарочно сломанная база отдельно. Не назван ни один
кусок — сборка ничего не трогает и перечисляет, какие куски бывают.

Кит и агент Claude Code подменены заглушками: настоящий кит полез бы в живую сверку, а
настоящий агент стоит денег и прав. Заглушки умеют отвечать и здорово, и криво — как именно,
задают файлы kit-mode.txt и claude-mode.txt в корне песочницы; они читаются на каждый вызов,
и панель для смены режима перезапускать не нужно.

.EXAMPLE
pwsh -NoProfile -File scripts/sandbox.ps1 -Pieces house

.EXAMPLE
pwsh -NoProfile -File scripts/sandbox.ps1 -Pieces house,quirks -RealAgent
#>
# Без позиционных параметров: «-Pieces house quirks» через пробел — ошибка о лишнем слове, а не свой кусок «quirks».
[CmdletBinding(PositionalBinding = $false)]
param(
    # Куски песочницы через запятую — какие бывают, скрипт печатает, если не назвать ни одного.
    [string[]]$Pieces = @(),
    # Свой кусок задачи: скрипт вне кода панели, который кладёт в песочницу случай, которого нет
    # в готовых кусках. Выполняется после названных кусков, теми же кирпичами — sandbox.md.
    [string]$TaskPiece,
    # Каталог песочницы; пересобирается целиком при каждом запуске. По умолчанию у каждой рабочей
    # копии свой — по её имени: сборка из соседней копии чужую приёмку не заденет.
    [string]$Root,
    # Порт панели на песочнице. По умолчанию свой у каждой песочницы, закреплённый за её каталогом.
    [int]$Port,
    # Не подменять агента: панель будет звать настоящий claude. Деньги и настоящие права.
    [switch]$RealAgent,
    # Не поднимать процессы-пустышки под живые сессии агентов.
    [switch]$NoSessions,
    # Не собирать песочницу, а сверить живое состояние со снимком, снятым при сборке.
    [switch]$Verify,
    # Не собирать песочницу, а выпустить новую версию плагина кита — как обновление плагина Claude Code.
    [switch]$UpdateKit,
    # С -UpdateKit: удалить папку прежней версии кита, как это иногда делает обновление плагина.
    [switch]$DropOldKit
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = Split-Path $PSScriptRoot -Parent
$copyName = Split-Path $repo -Leaf
# Не прежний общий каталог «sandbox»: сборка по старому скрипту из другой ветки снесла бы его целиком.
$sandboxes = Join-Path $env:LOCALAPPDATA 'agents-kit-web\sandboxes'
$portsFile = Join-Path $sandboxes 'ports.json'

# Порты песочниц закреплены за их каталогами в общем файле: у двух песочниц адрес не совпадёт,
# а у одной он тот же от сборки к сборке. Рядом с портом записана копия, собравшая песочницу, —
# по ней одноимённая копия из другого места получает свой каталог. Порт панели чётный, API — следующий.
function Read-SandboxPorts {
    $ports = @{}
    if (-not (Test-Path -LiteralPath $portsFile)) { return $ports }
    $saved = try { Get-Content -LiteralPath $portsFile -Raw | ConvertFrom-Json } catch {
        throw "реестр портов песочниц не прочитан: $portsFile — поправьте или удалите его, иначе выданные порты раздадутся заново"
    }
    if ($saved) { foreach ($entry in $saved.PSObject.Properties) { $ports[$entry.Name] = $entry.Value } }
    return $ports
}

function Get-SandboxKey([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant() }

function Get-SandboxPort([string]$Dir) {
    New-Item -ItemType Directory -Path $sandboxes -Force | Out-Null
    # Две копии, собирающие песочницы впервые одновременно, иначе взяли бы один порт.
    $lockFile = Join-Path $sandboxes 'ports.lock'
    $lock = $null
    foreach ($try in 1..100) {
        try { $lock = [IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None'); break } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $lock) { throw "реестр портов песочниц занят другой сборкой дольше двадцати секунд: $lockFile" }
    try {
        $ports = Read-SandboxPorts
        $key = Get-SandboxKey $Dir
        if ($ports.ContainsKey($key)) { return [int]$ports[$key].port }
        $taken = @($ports.Values | ForEach-Object { [int]$_.port })
        $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
        $port = 5100
        while ($taken -contains $port -or $listening -contains $port -or $listening -contains ($port + 1)) { $port += 2 }
        $ports[$key] = [pscustomobject]@{ port = $port; copy = $repo }
        Write-Utf8 $portsFile (ConvertTo-Json -InputObject ([pscustomobject]$ports) -Depth 3)
        return $port
    }
    finally { $lock.Dispose() }
}

if (-not $Root) {
    $Root = Join-Path $sandboxes $copyName
    $owner = (Read-SandboxPorts)[(Get-SandboxKey $Root)]
    if ($owner -and $owner.copy -ne $repo) {
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($repo.ToLowerInvariant()))).Substring(0, 6).ToLowerInvariant()
        $Root = Join-Path $sandboxes "$copyName-$hash"
    }
}

$state = Join-Path $Root 'state.json'

# Снимок живого состояния: список отслеживаемых баз оператора и каждая живая база и её личный репозиторий
# local\me — у каждого свой git, их HEAD и незакоммиченные правки. Песочница ничего этого касаться не должна, и «-Verify» это показывает.
# Живые базы меняют и соседние сессии, поэтому расхождение называет файл: по нему видно, чья это
# работа — панели песочницы или сессии в другой копии.
function Get-LiveSnapshot {
    $file = Join-Path $env:APPDATA 'agents-kit-web\bases.json'
    $snapshot = [ordered]@{ basesFile = $null; bases = [ordered]@{} }
    if (-not (Test-Path -LiteralPath $file)) { return $snapshot }
    $snapshot.basesFile = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $live = try { (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).bases } catch { @() }
    # Живая база бывает и не под git, и без коммитов: её снимок — пустые строки, а не падение сборки.
    $PSNativeCommandUseErrorActionPreference = $false
    # Личный репозиторий git базы не видит — local\ у неё в .gitignore, — а панель пишет туда ответы, бэклог и файлы.
    $repos = @($live | ForEach-Object { $_; Join-Path $_ 'local\me' })
    foreach ($base in $repos) {
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

# Раскладка базы кита формата 8, как в его link-state.ps1: копии этой машины и её оператор — local\me.json,
# личный репозиторий оператора local\me со своим git — флоу, исполнители, бэклог, память задач по машинам с флоу
# каждой задачи рядом и их артефакты,
# папка оператора people\<имя> — выложенное для коллег. Оператор песочницы — «sandbox».
$sandboxOperator = 'sandbox'
function Get-SandboxMachine {
    $name = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }
    return ([regex]::Replace($name.ToLowerInvariant(), '[^\p{L}\p{Nd}]+', '-')).Trim('-')
}
function Get-Personal([string]$Base) { Join-Path $Base 'local\me' }
function Get-OperatorDir([string]$Base) { Join-Path $Base "people\$sandboxOperator" }
# Каталог памяти задач копий этой машины.
function Get-MemoryDir([string]$Base) { Join-Path (Get-Personal $Base) "work\$(Get-SandboxMachine)" }

# Исполнители оператора: их зовёт флоу песочницы, и оттуда же кит развозит их по копиям. Кладутся
# в личный репозиторий каждой базы до первого коммита — в живой базе они тоже лежат в истории.
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

# Флоу в форме кита — в личном репозитории: сценарии в flow\scenarios.md и этапы по файлу в flow\stages. Сценариев два — «полный»
# и «мелкий» из общих этапов: на них видно, что этап правится один раз, а возвраты у каждого сценария свои.
# У возврата «Ревью» стоит предел кругов, у возврата «Приёмки» — нет: видны оба случая.
function New-Flow([string]$Path) {
    Write-Utf8 (Join-Path $Path 'flow\scenarios.md') @'
# Песочница — сценарии

Задачу из бэклога без слов оператора брать по наименьшему номеру.

## полный
когда: новая возможность или правка в нескольких местах
1. [Критерий](stages/criterion.md)
2. [Ветка](stages/branch.md)
3. [Реализация](stages/implementation.md)
4. [Ревью](stages/review.md)
   - возврат: блокер или мажор — этап «Реализация»
     - кругов: 2
5. [Сборка](stages/build.md)
6. [Приёмка](stages/acceptance.md)
   - возврат: замечания — этап «Реализация»
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

# Бэклог оператора — в личном репозитории, $Path — его корень. Буквы номеров у проекта свои: $Orders даёт бэклог с буквами «ORD» — с записью
# чужими буквами, которую кит перенумерует, и с записью без номера.
function New-Backlog([string]$Path, [switch]$Orders) {
    if ($Orders) {
        # Артефакт записи ORD-14 — файл в artifacts/ личного репозитория, как его кладёт кит: окно записи открывает его в VS Code.
        Write-Utf8 (Join-Path $Path 'artifacts\ORD-14-образец-выгрузки.csv') "номер;дата;сумма`nORD-1001;2026-09-01;1200`n"
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

### Артефакты
- образец выгрузки от бухгалтерии: artifacts/ORD-14-образец-выгрузки.csv
- обсуждение с бухгалтерией: https://example.com/orders/14

### Агенту
- где: выдуманный модуль выгрузки

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
        # Файл кита лежит в artifacts/ личного репозитория рядом с памятью, и ссылка на него — путь от его корня:
        # память — work\<машина>\<файл>.md.
        $personal = Split-Path (Split-Path (Split-Path $Path))
        Write-Utf8 (Join-Path $personal 'artifacts\ORD-12-снимок-выгрузки.md') "# Снимок выгрузки`n`nВыдуманный артефакт песочницы в artifacts/ личного репозитория.`n"
        # Файл по-старому — полным путём вне копии: в копии он был бы неотслеживаемой правкой её git. Щелчок
        # в окне ответа открывает его в VS Code, как раньше.
        $spec = Join-Path $Root 'files\export-spec.md'
        Write-Utf8 $spec "# Спецификация выгрузки заказов`n`nВыдуманный файл песочницы: артефакт задачи ORD-12.`n"
        "`n## Артефакты`n- макет выгрузки: https://claude.ai/artifact/SandboxMock1`n- снимок выгрузки: artifacts/ORD-12-снимок-выгрузки.md`n- спецификация выгрузки: $spec`n"
    } else { '' }
    # Макет по-старому, подразделом критериев: окно его не показывает ни артефактом, ни критерием.
    $designBlock = if ($OldDesign) { "`n### Дизайн`nМакет: https://claude.ai/artifact/SandboxOld1`n" } else { '' }

    $text = @"
# $Task

рабочая копия: $Copy
ветка: $Branch
сценарий: мелкий
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

### Сценарий
- [x] 1. Ветка — выход: feat/polling от dev
- [ ] 2. Реализация
- [ ] 3. Приёмка
- [ ] 4. Мерж

### Шаги
- [x] Замерить, сколько длится опрос — результат: 40 мс на копию — проверен: вывод прогона
- [ ] Свести опрос к одному запросу
"@
    Write-Utf8 $Path $text -Crlf:$Crlf

    # Флоу задачи — копия её сценария, которую кит формата 8 снимает при взятии: каталог рядом с памятью под тем же
    # именем, в нём flow\scenarios.md с одним сценарием задачи и файлы его этапов. Задача идёт по ней, и правка флоу
    # базы её не трогает.
    $taskFlow = Join-Path (Split-Path $Path) ([IO.Path]::GetFileNameWithoutExtension($Path))
    New-Flow $taskFlow
    Write-Utf8 (Join-Path $taskFlow 'flow\scenarios.md') @'
# Песочница — сценарии

Задачу из бэклога без слов оператора брать по наименьшему номеру.

## мелкий
когда: правка в одном месте, без новых решений
1. [Ветка](stages/branch.md)
2. [Реализация](stages/implementation.md)
3. [Приёмка](stages/acceptance.md)
4. [Мерж](stages/merge.md)
'@
    foreach ($slug in 'criterion', 'review', 'build') {
        Remove-Item -LiteralPath (Join-Path $taskFlow "flow\stages\$slug.md")
    }
}

# Выдуманная база знаний: та же раскладка, что у настоящей, — кита формата 8, и панель читает её теми же правилами.
# $StagesOnly — этапы без списка сценариев, $NoFlow — ни этапов, ни сценариев. $Format 5 — база до перевода китом
# на формат 6: флоу и исполнители ещё в папке оператора общей базы.
function New-Base([string]$Path, [string]$Title, [string[]]$Copies, [switch]$NoProduct, [switch]$BrokenJson, [switch]$FlowUncommitted,
    [switch]$Orders, [switch]$StagesOnly, [switch]$NoFlow, [int]$Format = 8) {
    New-Repo $Path
    if (-not $NoProduct) {
        Write-Utf8 (Join-Path $Path 'product.md') @"
# $Title — продукт

## Что за система

- Выдуманный проект песочницы: нужен, чтобы панели было что показывать.
- Живого кода за ним нет.
"@
    }
    $prefix = if ($Orders) { 'ORD' } else { 'B' }
    if ($BrokenJson) {
        Write-Utf8 (Join-Path $Path 'agents-kit.json') '{ "kit": "agents-kit", "version": тут оборвалось'
    }
    else {
        Write-Json (Join-Path $Path 'agents-kit.json') ([pscustomobject]@{ kit = 'agents-kit'; prefix = $prefix; version = $Format })
    }
    Write-Json (Join-Path $Path 'local\me.json') ([pscustomobject]@{ operator = $sandboxOperator; workspaces = @($Copies) })
    $personal = Get-Personal $Path
    $operatorDir = Get-OperatorDir $Path
    # Свои флоу и исполнители оператора — в личном репозитории; папка оператора в общей базе держит выложенное для
    # коллег и есть и пустой: кит кладёт в неё каркас пустого флоу. У базы формата 5 — наоборот, свои там.
    $own = if ($Format -ge 6) { $personal } else { $operatorDir }
    if ($Format -ge 6) { Write-Utf8 (Join-Path $operatorDir 'flow\scenarios.md') "# $Title — сценарии`n" }
    New-Repo $personal
    if (-not $FlowUncommitted -and -not $NoFlow) { New-Flow $own }
    if ($StagesOnly) { Remove-Item -LiteralPath (Join-Path $own 'flow\scenarios.md') }
    New-Agents $own
    Write-Utf8 (Join-Path $Path '.gitignore') "local/`n"
    Add-Commit $Path 'Каркас базы песочницы'

    New-Backlog $personal -Orders:$Orders
    New-Item -ItemType Directory -Path (Get-MemoryDir $Path) -Force | Out-Null
    Add-Commit $personal 'Каркас личного репозитория'
    # Флоу, которого нет в истории: список флоу панель коммитит без git add, и такой файл ей не закоммитить.
    if ($FlowUncommitted) { New-Flow $own }
}


# --- сборка ------------------------------------------------------------------------------

if ($Verify) {
    Compare-Live (Join-Path $Root 'live-snapshot.json')
    return
}

# Кит песочницы стоит плагином Claude Code, как его ставит установщик: каталог версии в кэше плагинов
# и запись в installed_plugins.json. Обновление кладёт новую версию рядом и переписывает запись.
function Write-KitPlugin([string]$ClaudeDir, [string]$KitDir, [string]$Version) {
    Write-Json (Join-Path $KitDir '.claude-plugin\plugin.json') ([pscustomobject]@{ name = 'agents-kit'; version = $Version })
    Write-Json (Join-Path $ClaudeDir 'plugins\installed_plugins.json') ([pscustomobject]@{
        version = 2
        plugins = [pscustomobject]@{
            'agents-kit@agents-kit' = @([pscustomobject]@{ scope = 'user'; installPath = $KitDir; version = $Version })
        }
    })
}

if ($UpdateKit) {
    $installed = Join-Path $Root 'claude\plugins\installed_plugins.json'
    if (-not (Test-Path -LiteralPath $installed)) { throw "плагина кита нет: $installed — сначала соберите песочницу" }
    $old = @((Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json).plugins.'agents-kit@agents-kit')[0]
    $parts = $old.version.Split('.')
    $version = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
    $fresh = Join-Path (Split-Path $old.installPath -Parent) $version
    Copy-Item -LiteralPath $old.installPath -Destination $fresh -Recurse
    Write-KitPlugin (Join-Path $Root 'claude') $fresh $version
    if ($DropOldKit) { Remove-Item -LiteralPath $old.installPath -Recurse -Force }
    Write-Host "Плагин кита обновлён: $($old.version) -> $version"
    Write-Host "  новая версия:   $fresh"
    Write-Host "  прежняя версия: $($old.installPath)$(if ($DropOldKit) { ' — удалена' })"
    return
}

# Куски песочницы: каждый собирается сам по себе, и в песочнице лежит только названное под задачу.
$pieceList = [ordered]@{
    'house'       = 'здоровый проект «Дом»: три копии, память с тремя вопросами оператору, живые сессии'
    'orders'      = 'проект «Заказы» со своими буквами номеров ORD, записью чужими буквами и артефактами в памяти'
    'tracker'     = 'проекты с трекером: GitHub с задачами на оператора, GitHub без адреса репозитория и Jira'
    'no-product'  = 'база без описания проекта: название берётся из имени папки'
    'broken-json' = 'база с битым agents-kit.json: базу не прочитать'
    'old-format'  = 'база прежнего формата кита: панель её не читает, называет причину и переводит кнопкой в «Проблемах баз»'
    'new-format'  = 'база нового формата кита: панель её показывает с предупреждением, а флоу, исполнителей и бэклог не правит'
    'stages-only' = 'база с этапами без сценариев: пустое состояние вкладки «Сценарии»'
    'no-flow'     = 'база без этапов и сценариев: пустые состояния раздела «Флоу»'
    'quirks'      = 'кривые копии и памяти: кириллица, не git, «..», пропавшая копия, CRLF, две памяти, файл мёртвой сессии'
    'broken-kit'  = 'кит без скриптов: путь к нему «Настройки» не примут'
    'load'        = 'база на полсотни копий — панель под опросом; собирается долго'
}
$chosen = @($Pieces | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
$unknown = @($chosen | Where-Object { -not $pieceList.Contains($_) })
if (($chosen.Count -eq 0 -and -not $TaskPiece) -or $unknown.Count) {
    if ($unknown.Count) { Write-Host "Таких кусков нет: $($unknown -join ', ')" }
    else { Write-Host 'Песочница собирается под задачу: назовите куски ключом -Pieces, через запятую, или свой кусок ключом -TaskPiece.' }
    Write-Host ''
    foreach ($name in $pieceList.Keys) { Write-Host ('  {0,-12} {1}' -f $name, $pieceList[$name]) }
    Write-Host ''
    Write-Host 'Каталог песочницы не тронут.'
    exit 1
}
function Test-Piece([string]$Name) { $chosen -contains $Name }
# Свой кусок читается до сноса каталога: он может лежать и в прежней песочнице.
$taskPieceText = $null
if ($TaskPiece) {
    if (-not (Test-Path -LiteralPath $TaskPiece -PathType Leaf)) { throw "своего куска нет: $TaskPiece — каталог песочницы не тронут" }
    $TaskPiece = (Resolve-Path -LiteralPath $TaskPiece).Path
    # Свой кусок в код панели не попадает: в рабочей копии он уехал бы в коммит ветки.
    if ($TaskPiece.StartsWith($repo.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "свой кусок лежит в рабочей копии: $TaskPiece — положите его вне репозитория; каталог песочницы не тронут"
    }
    $taskPieceText = Get-Content -LiteralPath $TaskPiece -Raw
}
if (-not $Port) { $Port = Get-SandboxPort $Root }

$live = Get-LiveSnapshot

Stop-OldDummies
if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
New-Item -ItemType Directory -Path $Root -Force | Out-Null

$panelDir = Join-Path $Root 'panel'
$sessionsDir = Join-Path $Root 'sessions'
$claudeDir = Join-Path $Root 'claude'
$binDir = Join-Path $Root 'bin'
# Подставная gh — в своём каталоге: она впереди PATH и с настоящим агентом.
$ghDir = Join-Path $Root 'gh-bin'
$basesDir = Join-Path $Root 'bases'
$copiesDir = Join-Path $Root 'copies'
foreach ($dir in @($panelDir, $sessionsDir, $claudeDir, $binDir, $ghDir, $basesDir, $copiesDir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$kitVersion = '1.14.2'
$kitDir = Join-Path $claudeDir "plugins\cache\agents-kit\agents-kit\$kitVersion"
# Правила формы этапа заглушка берёт у установленного кита — с ними и настоящий агент (-RealAgent) пишет
# этапы как в жизни. Путь к киту — из списка баз оператора, только на чтение; нет его — место по умолчанию.
$installedKit = try { (Get-Content -LiteralPath (Join-Path $env:APPDATA 'agents-kit-web\bases.json') -Raw | ConvertFrom-Json).kit } catch { $null }
if (-not $installedKit) { $installedKit = Join-Path $HOME '.claude\skills\agents-kit' }
# Формат, который знает заглушка, — формат панели из BaseLayout.cs: переведённая заглушкой база должна читаться.
$panelLayout = Get-Content -LiteralPath (Join-Path $repo 'backend\src\AgentsKitWeb.Api\Bases\BaseLayout.cs') -Raw
if ($panelLayout -notmatch 'public const int Format = (\d+);') { throw 'в BaseLayout.cs не найден формат панели — заглушку кита не собрать' }
$panelFormat = [int]$Matches[1]
New-Kit $kitDir -Rules (Join-Path $installedKit 'reference\flow-stages.md') -Layout (Join-Path $installedKit 'reference\base-layout.md') -Format $panelFormat
Write-KitPlugin $claudeDir $kitDir $kitVersion
New-ClaudeStub $binDir
New-GhStub $ghDir
Write-Utf8 (Join-Path $Root 'kit-mode.txt') "ok`n"
Write-Utf8 (Join-Path $Root 'claude-mode.txt') "ok`n"
Write-Utf8 (Join-Path $Root 'gh-mode.txt') "ok`n"
Write-Utf8 (Join-Path $Root 'sync-mode.txt') "ok`n"
Write-Utf8 (Join-Path $Root 'migrate-mode.txt') "ok`n"
# Задачи GitHub по репозиториям; кусок с трекером кладёт свои.
$ghIssues = [ordered]@{}
$ghLabels = [ordered]@{}
# Подставной YouTrack — на своём порту, в стороне от портов песочниц (они идут парами от 5100): у каждой
# песочницы свой порт, значит, и свой сервер YouTrack. Задачи — по проектам; кусок с трекером кладёт свои.
$youTrackPort = $Port + 1000
$youTrackServer = "http://localhost:$youTrackPort"
$youTrackIssues = [ordered]@{}
New-YouTrackStub $Root $youTrackPort
Write-Utf8 (Join-Path $Root 'youtrack-mode.txt') "ok`n"
# Подставная облачная Jira — следующим портом за YouTrack (B-285): порты песочниц чётные, и он ничей.
$jiraPort = $Port + 1001
$jiraServer = "http://localhost:$jiraPort"
$jiraIssues = [ordered]@{}
New-JiraStub $Root $jiraPort
Write-Utf8 (Join-Path $Root 'jira-mode.txt') "ok`n"

$links = [Collections.Generic.List[object]]::new()
$findings = [Collections.Generic.List[object]]::new()
$bases = [Collections.Generic.List[string]]::new()
$dummies = [Collections.Generic.List[int]]::new()

# --- здоровый набор ----------------------------------------------------------------------

if (Test-Piece 'house') {
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
    New-Memory (Join-Path (Get-MemoryDir $goodBase) 'house-task.md') $goodWorktree 'feat/polling' -ThreeQuestions
    Add-Commit (Get-Personal $goodBase) 'Память задачи'
    $bases.Add($goodBase)
    foreach ($copy in @($goodCopy, $goodWorktree, $goodDone)) {
        $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $goodBase })
    }
    $findings.Add([pscustomobject]@{ base = $goodBase; findings = @() })
}

# Проект со своими буквами номеров — «ORD», а не «B»: панель узнаёт номер по буквам проекта.
# В одной копии идёт задача ORD-12, в другой — задача не из бэклога, чей заголовок начат словом
# «UTF-8»: номером оно не становится. Третья копия свободна — в неё берут записи бэклога.
if (Test-Piece 'orders') {
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
    New-Memory (Join-Path (Get-MemoryDir $ordersBase) 'orders-export.md') $ordersTask 'feat/ord-12-export' -Task 'ORD-12 Выгрузка заказов за период' -Artifacts
    New-Memory (Join-Path (Get-MemoryDir $ordersBase) 'orders-utf.md') $ordersUtf 'fix/utf-names' -Task 'UTF-8 в именах файлов ломает выгрузку' -OldDesign
    Add-Commit (Get-Personal $ordersBase) 'Памяти задач'
    $bases.Add($ordersBase)
    foreach ($copy in @($ordersCopy, $ordersTask, $ordersUtf)) {
        $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $ordersBase })
    }
    $findings.Add([pscustomobject]@{ base = $ordersBase; findings = @(
        [pscustomobject]@{ severity = 'FAIL'; file = 'backlog.md'; message = 'номер чужими буквами: B-7' }) })
}

# Проекты с трекером (B-277, B-288): открытые задачи проекта — свои, чужие и ничьи (AKW-17) — раздел «Бэклог»
# показывает на вкладке «Задачи трекера». Трекер описание называет строками «трекер:», «сервер:», «проект:» (кит формата 7). Задачи GitHub отдаёт
# подставная gh из gh-issues.json, задачи YouTrack — подставной сервер youtrack-stub.ps1 из youtrack-issues.json,
# задачи Jira — jira-stub.ps1 из jira-issues.json (B-285); ключ (у Jira — и почту) оператор вводит в окне трекера
# проекта в разделе «Трекеры». Ещё проекты: YouTrack на сервере без ключа, YouTrack с проектом, которого на сервере
# нет, описание без строк и GitLab — задач панель не читает и называет причину.
if (Test-Piece 'tracker') {
    $trackerCopy = Join-Path $copiesDir 'tracker'
    $trackerBase = Join-Path $basesDir 'tracker-knowledge'
    New-Repo $trackerCopy
    Write-Utf8 (Join-Path $trackerCopy 'README.md') "# Трекер`n`nВыдуманный проект песочницы.`n"
    Add-Commit $trackerCopy 'Первый коммит'
    New-Base $trackerBase 'Трекер' @($trackerCopy)
    Write-Utf8 (Join-Path $trackerBase 'tracker.md') @'
# Трекер — трекер

## Где задачи

трекер: GitHub
сервер: https://github.com
проект: sandbox/tracker

Ходить программой gh.

## Показ бэклога
Открытые задачи, назначенные на меня.

## Взятие задачи
Задача в работе, если на ней метка in-progress. Назначить на себя и поставить метку in-progress.

## Задача закрыта
Ничего: задачу закрывает мерж.

## Вынос записи бэклога
Новая задача в том же репозитории, без меток.
'@
    Add-Commit $trackerBase 'Трекер проекта'
    # Запись с приложенным файлом и ссылкой: при переносе в трекер Чудо-Юдо просит прикрепить файл к задаче и ждёт
    # «перенёс», а окно предупреждает, что файл в задачу сам не попадёт (AKW-15).
    $trackerPersonal = Get-Personal $trackerBase
    Write-Utf8 (Join-Path $trackerPersonal 'artifacts\B-3-снимок-окна.png') 'снимок окна ответа'
    $trackerBacklog = Join-Path $trackerPersonal 'backlog.md'
    Write-Utf8 $trackerBacklog (((Get-Content -LiteralPath $trackerBacklog -Raw -Encoding utf8) -replace 'следующий номер: B-3', 'следующий номер: B-4').TrimEnd() + @'


## B-3 Экспорт истории задачи копии в markdown

Из окна ответа нужна выгрузка всей истории задачи копии одним файлом markdown: вопросы, ответы и шаги — в порядке ленты.

### Артефакты
- снимок окна ответа: artifacts/B-3-снимок-окна.png
- образец формата: https://commonmark.org/help/

### Агенту
- где: вкладка «Контекст» окна ответа

'@)
    Add-Commit $trackerPersonal 'Запись с файлом для переноса в трекер'
    # Копия, где идёт задача из трекера: пока она идёт, описание трекера не удалить (B-293), и её «Взять задачу»
    # в «Бэклоге» погашено.
    $trackerTask = Join-Path $copiesDir 'tracker-gh-48'
    git -C $trackerCopy worktree add -b feat/gh-48 $trackerTask --quiet
    New-Memory (Join-Path (Get-MemoryDir $trackerBase) 'tracker-gh-48.md') $trackerTask 'feat/gh-48' -Task 'GitHub #48 Показывать версию кита в «Настройках»'
    Add-Commit $trackerPersonal 'Задача из трекера'
    $links.Add([pscustomobject]@{ path = $trackerTask; status = 'Linked'; base = $trackerBase })
    # Метки задач — как их отдаёт gh; у #7 меток нет. Перечень фильтра «Метки» — все метки репозитория, и среди них
    # есть метки, которых нет ни у одной задачи (B-305). Исполнители — логины: gh вошла как sandbox-operator, #61 —
    # чужая, #7 — ничья, #63 закрыта и не видна (AKW-17).
    $label = { param($name, $color) [pscustomobject]@{ name = $name; color = $color } }
    $ghIssues['sandbox/tracker'] = @(
        [pscustomobject]@{ number = 52; title = 'Панель не стартует, если путь к киту содержит пробел'; url = 'https://github.com/sandbox/tracker/issues/52'; labels = @((& $label 'bug' 'd73a4a'), (& $label 'windows' '1d76db')); milestone = 'v2'; assignees = @('sandbox-operator') }
        [pscustomobject]@{ number = 48; title = 'Показывать версию кита в «Настройках»'; url = 'https://github.com/sandbox/tracker/issues/48'; labels = @((& $label 'enhancement' 'a2eeef'), (& $label 'frontend' 'fbca04')); assignees = @('sandbox-operator', 'anna-k') }
        [pscustomobject]@{ number = 61; title = 'Кнопка «Обновить» мигает, пока трекер отвечает'; url = 'https://github.com/sandbox/tracker/issues/61'; labels = @((& $label 'bug' 'd73a4a')); assignees = @('anna-k') }
        [pscustomobject]@{ number = 7; title = 'Установщик проверяет вход в Claude Code до скачивания сборки'; url = 'https://github.com/sandbox/tracker/issues/7'; labels = @() }
        [pscustomobject]@{ number = 63; title = 'Закрытая задача — на вкладке её нет'; url = 'https://github.com/sandbox/tracker/issues/63'; labels = @(); assignees = @('sandbox-operator'); closed = $true }
    )
    $ghLabels['sandbox/tracker'] = @('bug', 'documentation', 'enhancement', 'frontend', 'good first issue', 'windows')
    $bases.Add($trackerBase)
    $links.Add([pscustomobject]@{ path = $trackerCopy; status = 'Linked'; base = $trackerBase })
    $findings.Add([pscustomobject]@{ base = $trackerBase; findings = @() })

    # YouTrack: своя копия — задачу YouTrack в неё берут, а запись её бэклога переносят в YouTrack.
    $ytCopy = Join-Path $copiesDir 'tracker-youtrack'
    New-Repo $ytCopy
    Write-Utf8 (Join-Path $ytCopy 'README.md') "# YouTrack`n`nВыдуманный проект песочницы.`n"
    Add-Commit $ytCopy 'Первый коммит'
    $ytBase = Join-Path $basesDir 'tracker-youtrack'
    New-Base $ytBase 'YouTrack' @($ytCopy)
    Write-Utf8 (Join-Path $ytBase 'tracker.md') @"
# YouTrack — трекер

## Где задачи

трекер: YouTrack
сервер: $youTrackServer
проект: ABC

Ходить MCP-сервером youtrack.

## Показ бэклога
Незакрытые задачи проекта, назначенные на меня.

## Взятие задачи
Назначить на себя и перевести в состояние «В работе».

## Задача закрыта
Перевести в состояние «Готово».

## Вынос записи бэклога
Новая задача в том же проекте, назначенная на меня.
"@
    Add-Commit $ytBase 'Трекер проекта'
    # Исполнитель — владелец ключа sandbox.operator, чужой или никто (AKW-17).
    $operator = [pscustomobject]@{ login = 'sandbox.operator'; fullName = 'Оператор песочницы' }
    $youTrackIssues['ABC'] = @(
        [pscustomobject]@{ number = 7; title = 'Письмо о сбросе пароля уходит без ссылки'; state = 'To Do'; tags = @('почта'); assignee = $operator }
        [pscustomobject]@{ number = 12; title = 'Добавить роль «Бухгалтер» с доступом только к счетам'; state = 'In Progress'; tags = @(); assignee = [pscustomobject]@{ login = 'anna.kim'; fullName = 'Анна Ким' } }
        [pscustomobject]@{ number = 104; title = 'Импорт клиентов из CSV пропускает строки с кавычками в названии компании и в адресе доставки, если адрес набран через точку с запятой'; state = 'To Do'; tags = @() }
        [pscustomobject]@{ number = 1287; title = 'Перевести отчёты на новую схему налогов'; state = 'In Progress'; tags = @('отчёты'); assignee = $operator }
    )
    $bases.Add($ytBase)
    $links.Add([pscustomobject]@{ path = $ytCopy; status = 'Linked'; base = $ytBase })
    $findings.Add([pscustomobject]@{ base = $ytBase; findings = @() })

    # Jira: своя копия — задачу Jira в неё берут, а запись её бэклога переносят в Jira (B-285).
    $jiraCopy = Join-Path $copiesDir 'tracker-jira'
    New-Repo $jiraCopy
    Write-Utf8 (Join-Path $jiraCopy 'README.md') "# Jira`n`nВыдуманный проект песочницы.`n"
    Add-Commit $jiraCopy 'Первый коммит'
    $jiraBase = Join-Path $basesDir 'tracker-jira'
    New-Base $jiraBase 'Jira' @($jiraCopy)
    Write-Utf8 (Join-Path $jiraBase 'tracker.md') @"
# Jira — трекер

## Где задачи

трекер: Jira
сервер: $jiraServer
проект: PAY

MCP-сервер atlassian.

## Показ бэклога
Незакрытые задачи проекта PAY.

## Взятие задачи
Назначить на себя и перевести в статус «В работе».

## Задача закрыта
Ничего: задачу закрывает мерж.

## Вынос записи бэклога
Задача типа Task в проекте PAY, назначенная на меня.
"@
    Add-Commit $jiraBase 'Трекер проекта'
    # Исполнитель — владелец ключа (acc-operator), чужой или никто; PAY-3 закрыта и не видна; статусы и метки — для
    # фильтра проекта на вкладке «Задачи трекера».
    $jiraOperator = [pscustomobject]@{ accountId = 'acc-operator'; displayName = 'Оператор песочницы' }
    $jiraIssues['PAY'] = @(
        [pscustomobject]@{ number = 12; title = 'Повторная отправка вебхука после таймаута банка'; status = 'To Do'; labels = @('bank'); assignee = $jiraOperator }
        [pscustomobject]@{ number = 31; title = 'Сверка возвратов падает на пустой выписке'; status = 'In Progress'; labels = @(); assignee = [pscustomobject]@{ accountId = 'acc-anna'; displayName = 'Анна Петрова' } }
        [pscustomobject]@{ number = 7; title = 'Логировать идентификатор платежа в каждой строке журнала шлюза'; status = 'To Do'; labels = @('ops') }
        [pscustomobject]@{ number = 3; title = 'Закрытая задача — на вкладке её нет'; status = 'Done'; labels = @(); assignee = $jiraOperator; done = $true }
    )
    $bases.Add($jiraBase)
    $links.Add([pscustomobject]@{ path = $jiraCopy; status = 'Linked'; base = $jiraBase })
    $findings.Add([pscustomobject]@{ base = $jiraBase; findings = @() })

    $keys = { param($tracker, $server, $project) "`nтрекер: $tracker`nсервер: $server`nпроект: $project`n" }
    foreach ($other in @(
            @{ Dir = 'tracker-youtrack-nokey'; Title = 'YouTrack без ключа'; Where = (& $keys 'YouTrack' "$youTrackServer/other" 'ABC') }
            @{ Dir = 'tracker-youtrack-noproject'; Title = 'YouTrack без проекта'; Where = (& $keys 'YouTrack' $youTrackServer 'ZZZ') }
            @{ Dir = 'tracker-no-keys'; Title = 'Трекер без строк'; Where = 'GitHub Issues репозитория https://github.com/sandbox/tracker, ходить программой gh.' }
            @{ Dir = 'tracker-gitlab'; Title = 'Трекер GitLab'; Where = (& $keys 'GitLab' 'https://gitlab.com' 'sandbox/team/tracker') + "`nПрограммой glab." })) {
        $otherBase = Join-Path $basesDir $other.Dir
        New-Base $otherBase $other.Title @()
        Write-Utf8 (Join-Path $otherBase 'tracker.md') "# $($other.Title) — трекер`n`n## Где задачи`n$($other.Where)`n"
        Add-Commit $otherBase 'Трекер проекта'
        $bases.Add($otherBase)
        $findings.Add([pscustomobject]@{ base = $otherBase; findings = @() })
    }
}

# --- сломанный набор ---------------------------------------------------------------------

# Каждая кривая база отдельная: сломанное не должно мешать здоровому набору.

# База без описания проекта: название панель возьмёт из имени папки.
if (Test-Piece 'no-product') {
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
}

# База с битым agents-kit.json: базу не прочитать.
if (Test-Piece 'broken-json') {
    $brokenJsonBase = Join-Path $basesDir 'broken-json'
    New-Base $brokenJsonBase 'Битый список копий' @() -BrokenJson
    $bases.Add($brokenJsonBase)
    $findings.Add([pscustomobject]@{ base = $brokenJsonBase; findings = @(
        [pscustomobject]@{ severity = 'FAIL'; file = 'agents-kit.json'; message = 'список копий не разобран' }) })
}

# База прежнего формата кита — 5, как до перевода на 6, флоу и исполнители в папке оператора: таблица, «Флоу», «Исполнители», «Бэклог» и «Проблемы баз» называют
# причину — перевести её китом, — а связь копии кит отдаёт состоянием «прежний формат». «Проблемы баз» переводят её кнопкой
# заглушкой кита base-migrate.ps1, режим — migrate-mode.txt.
if (Test-Piece 'old-format') {
    $oldCopy = Join-Path $copiesDir 'old-format'
    New-Repo $oldCopy
    Write-Utf8 (Join-Path $oldCopy 'README.md') "# Проект на базе прежнего формата`n"
    Add-Commit $oldCopy 'Первый коммит'
    $oldBase = Join-Path $basesDir 'old-format'
    New-Base $oldBase 'Прежний формат' @($oldCopy) -Format 5
    $links.Add([pscustomobject]@{ path = $oldCopy; status = 'Outdated'; base = $oldBase })
    $bases.Add($oldBase)
    $findings.Add([pscustomobject]@{ base = $oldBase; findings = @() })
}

# База нового формата кита — на единицу новее формата панели, раскладка та же, как бывает, когда перевод не трогает
# читаемое панелью (B-281); номер берётся из BaseLayout.cs, чтобы кусок не стал обычной базой, когда панель его догонит:
# таблица, «Флоу», «Исполнители», «Бэклог» и «Проблемы баз» показывают её с предупреждением, правка флоу, исполнителей
# и бэклога закрыта, а ответить агенту и взять задачу в свободную копию можно.
if (Test-Piece 'new-format') {
    $newCopy = Join-Path $copiesDir 'new-format'
    New-Repo $newCopy
    Write-Utf8 (Join-Path $newCopy 'README.md') "# Проект на базе нового формата`n"
    Add-Commit $newCopy 'Первый коммит'
    $newTask = Join-Path $copiesDir 'new-format-task'
    git -C $newCopy worktree add -b feat/new-format $newTask --quiet
    $newBase = Join-Path $basesDir 'new-format'
    New-Base $newBase 'Новый формат' @($newCopy) -Format ($panelFormat + 1)
    New-Memory (Join-Path (Get-MemoryDir $newBase) 'new-format-task.md') $newTask 'feat/new-format'
    Add-Commit (Get-Personal $newBase) 'Память задачи'
    $bases.Add($newBase)
    foreach ($copy in @($newCopy, $newTask)) {
        $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $newBase })
    }
    $findings.Add([pscustomobject]@{ base = $newBase; findings = @(
        [pscustomobject]@{ severity = 'WARN'; file = 'product.md'; message = 'находка сверки кита — видна рядом с предупреждением' }) })
}

# База с этапами без сценариев и база без этапов и сценариев: на них видны пустые состояния
# вкладок раздела «Флоу» — у каждой своё, а переключатель вкладок на месте.
if (Test-Piece 'stages-only') {
    $stagesOnlyBase = Join-Path $basesDir 'stages-only'
    New-Base $stagesOnlyBase 'Этапы без сценариев' @() -StagesOnly
    $bases.Add($stagesOnlyBase)
    $findings.Add([pscustomobject]@{ base = $stagesOnlyBase; findings = @() })
}

if (Test-Piece 'no-flow') {
    $noFlowBase = Join-Path $basesDir 'no-flow'
    New-Base $noFlowBase 'Без флоу' @() -NoFlow
    $bases.Add($noFlowBase)
    $findings.Add([pscustomobject]@{ base = $noFlowBase; findings = @() })
}

# Кривые копии: одной нет на диске, вторая не под git, третья с кириллицей в пути,
# четвёртая записана через «..».
if (Test-Piece 'quirks') {
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
    New-Memory (Join-Path (Get-MemoryDir $quirksBase) 'копия-с-кириллицей.md') $cyrillicCopy 'main' -Crlf
    # Вопрос без строки «ответ:» — панели нечего заполнить, а форма памяти нарушена.
    New-Memory (Join-Path (Get-MemoryDir $quirksBase) 'dotted.md') $dottedCopy 'main' -NoAnswerKey
    # Несколько вопросов в одной памяти.
    New-Memory (Join-Path (Get-MemoryDir $quirksBase) 'not-git.md') $notGitCopy 'main' -TwoQuestions
    # Две памяти на одну копию: какая из них настоящая, панель не знает.
    New-Memory (Join-Path (Get-MemoryDir $quirksBase) 'копия-с-кириллицей-вторая.md') $cyrillicCopy 'feat/вторая'
    # Только памяти: флоу этой базы лежит в том же личном репозитории нарочно вне истории git.
    git -C (Get-Personal $quirksBase) add -- work
    git -C (Get-Personal $quirksBase) commit -q -m 'Памяти кривых копий'

    # Незакоммиченная правка бэклога: агент записи унёс бы её в свой коммит.
    Add-Content -LiteralPath (Join-Path (Get-Personal $quirksBase) 'backlog.md') -Value "`n## Запись без номера, дописанная руками`n" -Encoding utf8NoBOM

    $links.Add([pscustomobject]@{ path = $cyrillicCopy; status = 'Linked'; base = $quirksBase })
    $links.Add([pscustomobject]@{ path = $notGitCopy; status = 'NotGit'; base = $null })
    $links.Add([pscustomobject]@{ path = (Join-Path $copiesDir 'dotted'); status = 'Unlisted'; base = $quirksBase })
    $findings.Add([pscustomobject]@{ base = $quirksBase; findings = @(
        [pscustomobject]@{ severity = 'FAIL'; file = "local/me/work/$(Get-SandboxMachine)/копия-с-кириллицей-вторая.md"; message = 'две памяти на одну копию' }
        [pscustomobject]@{ severity = 'WARN'; file = 'local/me/backlog.md'; message = 'запись без номера' }
        [pscustomobject]@{ severity = 'WARN'; file = 'local/me/flow/scenarios.md'; message = 'сценарии не в истории git' }) })

    # Исполнитель, заведённый «оператором» прямо в базе и мимо панели: в разделе он виден наравне
    # с остальными, хотя панель его не заводила.
    Write-Utf8 (Join-Path (Get-Personal $quirksBase) 'agents\spec-writer.md') @"
---
name: spec-writer
description: Пишет спеку экрана по разговору с оператором.
---

Ты пишешь спеку экрана.
"@

    # Файл сессии на мёртвый процесс: он переживает свою сессию, живость видна только по процессу,
    # поэтому в строке этой копии панель работы показать не должна.
    Write-Session $sessionsDir 999123 (Join-Path $copiesDir 'dotted') @{ status = 'busy' }
}

# Кит без скриптов: путь к нему панель не примет, и это видно в «Настройках».
if (Test-Piece 'broken-kit') {
    $brokenKit = Join-Path $claudeDir 'skills\agents-kit-broken'
    New-Item -ItemType Directory -Path (Join-Path $brokenKit 'scripts') -Force | Out-Null
    Write-Utf8 (Join-Path $brokenKit 'README.md') "# Кит без скриптов`n`nПуть сюда панель принять не должна.`n"
}

# База на полсотни копий: собирается заметно дольше остального.
if (Test-Piece 'load') {
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
        if ($i % 5 -eq 0) { New-Memory (Join-Path (Get-MemoryDir $loadBase) "load-$i.md") $worktree "load/$i" }
    }
    Add-Commit (Get-Personal $loadBase) 'Памяти копий под нагрузку'
    $bases.Add($loadBase)
    $findings.Add([pscustomobject]@{ base = $loadBase; findings = @() })
}

# --- свой кусок задачи -------------------------------------------------------------------

# Кусок выполняется здесь же, точкой: ему видны кирпичи fixtures.ps1, функции баз этого скрипта
# и списки $bases, $links, $findings, $dummies, в которые он дописывает своё. Копия куска остаётся
# в песочнице — по ней видно, из чего она собрана.
if ($taskPieceText) {
    $taskPieceCopy = Join-Path $Root 'task-piece.ps1'
    Write-Utf8 $taskPieceCopy $taskPieceText
    . $taskPieceCopy
}

# --- таблицы заглушки кита и настройки панели --------------------------------------------

# Таблицы пишутся массивом и из одной строки, и пустыми: куски песочницы бывают и без копий.
Write-Utf8 (Join-Path $kitDir 'scripts\links.json') (ConvertTo-Json -InputObject $links.ToArray() -Depth 6)
Write-Utf8 (Join-Path $kitDir 'scripts\findings.json') (ConvertTo-Json -InputObject $findings.ToArray() -Depth 6)
Write-Json (Join-Path $panelDir 'bases.json') ([pscustomobject]@{ bases = $bases.ToArray(); kit = $kitDir })
Write-Utf8 (Join-Path $Root 'gh-issues.json') (ConvertTo-Json -InputObject ([pscustomobject]$ghIssues) -Depth 6)
Write-Utf8 (Join-Path $Root 'gh-labels.json') (ConvertTo-Json -InputObject ([pscustomobject]$ghLabels) -Depth 3)
Write-Utf8 (Join-Path $Root 'youtrack-issues.json') (ConvertTo-Json -InputObject ([pscustomobject]$youTrackIssues) -Depth 6)
Write-Utf8 (Join-Path $Root 'jira-issues.json') (ConvertTo-Json -InputObject ([pscustomobject]$jiraIssues) -Depth 6)

# --- живые сессии агентов ----------------------------------------------------------------

if ((Test-Piece 'house') -and -not $NoSessions) {
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
# Подставная gh впереди PATH всегда: с настоящим агентом панель всё равно не ходит в GitHub оператора.
$pathLine = if ($RealAgent) {
    "# агент настоящий: claude берётся из PATH как обычно`n`$env:PATH = '$ghDir;' + `$env:PATH"
}
else {
    "`$env:PATH = '$binDir;$ghDir;' + `$env:PATH"
}

# Панель — это фронт и API, как в разработке: API отдаёт собранный фронт только в поставленной
# панели, а песочница работает на том коде, что лежит в рабочей копии. Поэтому скрипт поднимает
# оба: API на своём порту, а dev-сервер фронта — на том, который открывает оператор, и он же
# проксирует на API.
Write-Utf8 (Join-Path $Root 'start-panel.ps1') @"
# Поднимает панель на песочнице: API и dev-сервер фронта. Живых баз панель не видит — список баз,
# реестр сессий, профиль Claude Code и отметка о поставленной панели
# взяты из песочницы, а не из профиля оператора. Новая настройка API с путём в профиле по умолчанию
# должна появиться и в этой строке, иначе песочница молча покажет живое.
# Гасится Ctrl+C: API останавливается вместе с фронтом.
`$ErrorActionPreference = 'Stop'
$pathLine

if (-not (Test-Path -LiteralPath '$(Join-Path $frontend 'node_modules')')) {
    throw 'нет node_modules фронта — сначала «npm install» в frontend'
}

`$api = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-Command',
    "dotnet run --project '$api' --no-launch-profile -- --urls 'http://localhost:$apiPort' --BasesFile '$(Join-Path $panelDir 'bases.json')' --SessionsDir '$sessionsDir' --ClaudeDir '$claudeDir' --PublishedFile '$(Join-Path $panelDir 'published.json')' --TrackersFile '$(Join-Path $panelDir 'trackers.json')' --FiltersFile '$(Join-Path $panelDir 'filters.json')' --VoiceDir '$(Join-Path $Root 'voice')' --FinishedSessionIntervalSeconds 10 --FinishedSessionDelaySeconds 20")
# Подставные YouTrack и Jira песочницы: ключ к ним — в окне трекера проекта в разделе «Трекеры» (trackers.json лежит
# рядом с bases.json песочницы, ключи оператора панель песочницы не видит).
`$youTrack = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-File', '$(Join-Path $Root 'youtrack-stub.ps1')')
`$jira = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-File', '$(Join-Path $Root 'jira-stub.ps1')')

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
    & taskkill.exe /PID `$youTrack.Id /T /F 2>`$null | Out-Null
    & taskkill.exe /PID `$jira.Id /T /F 2>`$null | Out-Null
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
Write-Host "  режим gh:       $(Join-Path $Root 'gh-mode.txt')      (ok, many, login, error, slow); задачи — gh-issues.json, метки репозиториев — gh-labels.json"
Write-Host "  сведение базы:  $(Join-Path $Root 'sync-mode.txt')    (ok, push-fail, pull-fail, offline, push-offline); вызовы — sync.log у скриптов кита"
Write-Host "  перевод базы:   $(Join-Path $Root 'migrate-mode.txt') (ok, operator, fail, slow, kit-old); вызовы — migrate.log у скриптов кита"
Write-Host "  YouTrack:       $youTrackServer, ключ perm:sandbox; режим — youtrack-mode.txt (ok, rejected, error, slow, slow-create), задачи — youtrack-issues.json"
Write-Host "  Jira:           $jiraServer, почта operator@sandbox.example, ключ sandbox-token; режим — jira-mode.txt (ok, rejected, error, slow), задачи — jira-issues.json"
# Пересборка повторяет те же ключи: без кусков песочница не соберётся.
$self = "pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'sandbox.ps1')`""
$where = ''
if ($PSBoundParameters.ContainsKey('Root')) { $where += " -Root `"$Root`"" }
$again = $self + $where
if ($chosen.Count) { $again += " -Pieces $($chosen -join ',')" }
if ($TaskPiece) { $again += " -TaskPiece `"$TaskPiece`"" }
if ($PSBoundParameters.ContainsKey('Port')) { $again += " -Port $Port" }
if ($RealAgent) { $again += ' -RealAgent' }
if ($NoSessions) { $again += ' -NoSessions' }
Write-Host ""
Write-Host "  пересобрать:    $again"
Write-Host "  обновить кит:   $self$where -UpdateKit [-DropOldKit]"
Write-Host "  сверить живое:  $self$where -Verify"
Write-Host ""
