<#
.SYNOPSIS
Собирает демонстрационный проект и поднимает на нём панель: выдуманные базы знаний и рабочие
копии, на которых панель выглядит как при обычной работе.

.DESCRIPTION
Демонстрация — для показа панели и для работы над её видом на заведомо одинаковых данных. Это не
песочница: поломок в ней нет, и она не одноразовая. Первый запуск собирает каталог демонстрации,
следующие поднимают её такой, какой её оставили; -Rebuild стирает её и собирает заново.

Живого демонстрационная панель не видит: список баз, реестр живых сессий, профиль Claude Code,
журналы расхода и ключ доступа она берёт из каталога демонстрации. Кит и агент подменены заглушками,
как в песочнице, и отвечают как при удачной работе.

.EXAMPLE
pwsh -NoProfile -File scripts/demo.ps1

.EXAMPLE
pwsh -NoProfile -File scripts/demo.ps1 -Rebuild
#>
param(
    # Каталог демонстрации; живёт между запусками.
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\demo'),
    # Порт демонстрационной панели; API берёт следующий за ним.
    [int]$Port = 5070,
    # Стереть демонстрацию и собрать её заново — такой, как в первый раз.
    [switch]$Rebuild,
    # Собрать и подготовить демонстрацию, но панель не поднимать.
    [switch]$NoPanel
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'fixtures.ps1')

$repo = Split-Path $PSScriptRoot -Parent
$state = Join-Path $Root 'demo.json'
$panelDir = Join-Path $Root 'panel'
$sessionsDir = Join-Path $Root 'sessions'
$claudeDir = Join-Path $Root 'claude'
$projectsDir = Join-Path $Root 'projects'
$binDir = Join-Path $Root 'bin'
$basesDir = Join-Path $Root 'bases'
$copiesDir = Join-Path $Root 'copies'
$kitDir = Join-Path $claudeDir 'skills\agents-kit'

function Read-State {
    if (-not (Test-Path -LiteralPath $state)) { return $null }
    try { return Get-Content -LiteralPath $state -Raw | ConvertFrom-Json } catch { return $null }
}

# Пустышки сессий гасятся по реестру самой демонстрации вместе с файлами: и заведённые этим скриптом,
# и те, что завела заглушка агента на запуске задачи из панели. Иначе от каждого запуска в разделе
# «Сессии» оставалось бы по лишней строке, а скрытые процессы висели бы сутками.
function Stop-Dummies {
    foreach ($file in @(Get-ChildItem -LiteralPath $sessionsDir -Filter '*.json' -ErrorAction Ignore)) {
        $session = try { Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $null }
        if ($session.pid) {
            # Номера процессов Windows переиспользует: гасим процесс, только если это наша пустышка.
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$session.pid)" -ErrorAction Ignore
            if ($process -and $process.Name -eq 'pwsh.exe' -and $process.CommandLine -like '*Start-Sleep -Seconds 86400*') {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction Ignore
            }
        }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Ignore
    }
}

function New-DemoRepo([string]$Path) { New-Repo $Path 'Демонстрация' 'demo@example.invalid' }

# --- содержимое баз ----------------------------------------------------------------------

function New-DemoAgents([string]$Path) {
    Write-Utf8 (Join-Path $Path 'agents\scout.md') @"
---
name: scout
description: Разведывает по коду, где живёт то, что трогает задача, и возвращает короткий отчёт с местами.
tools: Read, Grep, Glob
---

Ты находишь в коде места, которые трогает задача, и возвращаешь их списком с файлами и строками.
"@
    Write-Utf8 (Join-Path $Path 'agents\reviewer.md') @"
---
name: reviewer
description: Вычитывает дифф ветки задачи против критерия закрытия и возвращает замечания по классам.
tools: Read, Grep, Glob, Bash
model: opus
---

Ты читаешь дифф ветки целиком и возвращаешь замечания: блокер, мажор, минор.
"@
    Write-Utf8 (Join-Path $Path 'agents\doc-writer.md') @"
---
name: doc-writer
description: Пишет пользовательскую документацию по сделанному.
---

Ты пишешь документацию по сделанному в задаче.
"@
}

# Флоу в форме кита, два флоу из общих стадий. Исполнители стадий заведены в каждой базе.
function New-DemoFlow([string]$Path, [string]$Title) {
    Write-Utf8 (Join-Path $Path 'flow\flow.md') @"
# $Title — флоу

Задачу из бэклога без слов оператора брать по высшему приоритету, среди равных — по наименьшему номеру.

## полный
когда: новая возможность или правка в нескольких местах
1. [Ветка](stages/branch.md)
2. [Разведка](stages/research.md)
3. [Обсуждение](stages/discussion.md)
4. [Критерий](stages/criterion.md)
   - возврат: критерий упёрся в незакрытую развилку — стадия «Обсуждение»
5. [Реализация](stages/implementation.md)
6. [Ревью](stages/review.md)
   - возврат: блокер или мажор — стадия «Реализация»
7. [Приёмка](stages/acceptance.md)
   - возврат: замечания — стадия «Реализация»
8. [Мерж](stages/merge.md)

## мелкий
когда: правка в одном месте, без новых решений
1. [Ветка](stages/branch.md)
2. [Реализация](stages/implementation.md)
3. [Приёмка](stages/acceptance.md)
4. [Мерж](stages/merge.md)
"@
    $stages = [ordered]@{
        branch         = @'
# Ветка

исполнитель: оркестратор
выход: имя ветки в строке «ветка» памяти

- Завести ветку задачи от свежего dev до всякой работы.
'@
        research       = @'
# Разведка

исполнитель: scout
выход: карта мест в «Фактах» памяти
пропуск: задача не трогает код

- Разбить недостающее на независимые вопросы и отдать их разведчику разом.
'@
        discussion     = @'
# Обсуждение

исполнитель: оркестратор
помощники: scout
выход: ответы оператора в памяти на все вопросы обсуждения

- Развилки вынести оператору вопросами, по вопросу на развилку, с вариантами.
'@
        criterion      = @'
# Критерий

исполнитель: оркестратор
выход: критерий закрытия в памяти и ответ оператора, что критерий подтверждён

- Написать критерий по итогам обсуждения, до первой строчки кода.
'@
        implementation = @'
# Реализация

исполнитель: оркестратор
помощники: scout, doc-writer
выход: sha коммитов ветки и зелёные прогоны проверок в памяти

- Вести работу шагами, каждый со своей проверкой.
'@
        review         = @'
# Ревью

исполнитель: reviewer
выход: вердикт по sha проверенного коммита
пропуск: правка не трогает код

- Дать ревьюеру ветку задачи, базу сравнения и критерий закрытия.
'@
        acceptance     = @'
# Приёмка

исполнитель: оператор
выход: ответ оператора в памяти — «принято» или список замечаний
пропуск: правка не меняет ни вида, ни поведения

- Показать оператору, что и где смотреть.
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

function New-DemoBase([string]$Path, [string]$Title, [string]$About, [string]$Copy, [string]$Backlog) {
    New-DemoRepo $Path
    Write-Utf8 (Join-Path $Path 'product.md') @"
# $Title — продукт

## Что за система

$About
"@
    Write-Json (Join-Path $Path 'agents-kit.json') ([pscustomobject]@{ kit = 'agents-kit'; workspaces = @($Copy) })
    New-DemoFlow $Path $Title
    New-DemoAgents $Path
    Write-Utf8 (Join-Path $Path 'backlog.md') $Backlog
    New-Item -ItemType Directory -Path (Join-Path $Path 'work') -Force | Out-Null
    Write-Utf8 (Join-Path $Path '.gitignore') "local/`n"
    Add-Commit $Path 'Каркас базы'
}

# Код проекта: основная копия и копии задач рядом — настоящие git worktree. $Branches — папка копии → её ветка.
function New-DemoProject([string]$Name, [string]$Title, [Collections.Specialized.OrderedDictionary]$Branches = [ordered]@{}) {
    $main = Join-Path $copiesDir $Name
    New-DemoRepo $main
    Write-Utf8 (Join-Path $main 'README.md') "# $Title`n`nВыдуманный проект демонстрации панели.`n"
    Add-Commit $main 'Первый коммит'
    $copies = [ordered]@{ main = $main }
    foreach ($folder in $Branches.Keys) {
        $branch = $Branches[$folder]
        $path = Join-Path $copiesDir $folder
        git -C $main worktree add -b $branch $path --quiet
        $copies[$folder] = $path
    }
    return $copies
}

# --- сборка ------------------------------------------------------------------------------

function Build-Demo {
    Stop-Dummies
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
    foreach ($dir in @($panelDir, $sessionsDir, $claudeDir, $projectsDir, $binDir, $basesDir, $copiesDir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    New-Kit $kitDir -LinkNewCopies
    New-ClaudeStub $binDir 'демонстрация' 'демонстрации'

    $bases = [Collections.Generic.List[string]]::new()
    $links = [Collections.Generic.List[object]]::new()
    $copies = [ordered]@{}

    # «Кофейня»: одна задача идёт, другая ждёт ответа оператора, третья закончилась.
    $cafe = New-DemoProject 'cafe' 'Кофейня' ([ordered]@{
            'cafe-loyalty' = 'feat/cafe-14-loyalty'; 'cafe-menu' = 'feat/cafe-9-menu'; 'cafe-receipts' = 'feat/cafe-11-receipts' })
    $cafeBase = Join-Path $basesDir 'cafe-knowledge'
    New-DemoBase $cafeBase 'Кофейня' @'
- Сайт сети кофеен: меню, заказ навынос и бонусная программа.
- Гость заказывает с телефона и забирает заказ без очереди.
'@ $cafe.main @'
# Кофейня — бэклог

следующий номер: CAFE-19
поля: приоритет, тип

## CAFE-15 Оплата заказа не проходит с телефона на старом браузере

приоритет: высокий
тип: баг

Гость жмёт «Оплатить», кнопка крутится и ничего не происходит. Воспроизводится на Android 9 со встроенным браузером.

## CAFE-16 Время готовности заказа видно на экране гостя

приоритет: средний
тип: фича

Гость видит «будет готов через 7 минут» и не стоит у стойки впустую.

## CAFE-17 Меню показывает аллергены у каждого напитка

приоритет: средний
тип: фича

Бариста каждый день отвечает на одни и те же вопросы про молоко и орехи.

## CAFE-18 Письмо о заказе уходит дважды

приоритет: низкий
тип: баг

Иногда гость получает два одинаковых письма с подтверждением.
'@
    Write-Utf8 (Join-Path $cafeBase 'work\cafe-loyalty.md') @"
# CAFE-14 Каждый пятый кофе — в подарок
рабочая копия: $($cafe['cafe-loyalty'])
ветка: feat/cafe-14-loyalty
флоу: полный
Решения: нет

## Критерии закрытия

### 1. Гость видит, сколько кофе осталось до подарка
В личном кабинете гостя под последним заказом написано, сколько ещё чашек до бесплатной.

### 2. Пятый кофе в заказе бесплатный
Когда в заказе пятая чашка, её цена в чеке — ноль, а счётчик начинается заново.

### Не входит
Бонусы за еду и десерты.

## Оператору

## Агенту

### Критерии
- 1. проверка: e2e кабинета гостя — где: e2e/account.spec.ts
- 2. проверка: тест расчёта чека — где: tests/receipt.test.ts

### Вопросы

### Факты
- счётчик чашек живёт в профиле гостя, поле cupsTowardsFree

### Флоу
- [x] 1. Ветка — выход: feat/cafe-14-loyalty от dev
- [x] 2. Разведка — выход: карта мест в «Фактах»
- [x] 3. Обсуждение — выход: подарок — только напитки
- [x] 4. Критерий — выход: два критерия, ответ оператора «подтверждаю»
- [ ] 5. Реализация
- [ ] 6. Ревью
- [ ] 7. Приёмка
- [ ] 8. Мерж

### Шаги
- [x] счётчик чашек в профиле гостя — результат: 4f1c2a9 — проверен: dotnet test
- [x] пятая чашка бесплатна в чеке — результат: 9b0e7d3 — проверен: тест расчёта чека
- [ ] строка «до подарка» в кабинете гостя
- [ ] e2e кабинета гостя
"@
    Write-Utf8 (Join-Path $cafeBase 'work\cafe-menu.md') @"
# CAFE-9 Сезонное меню на главной странице
рабочая копия: $($cafe['cafe-menu'])
ветка: feat/cafe-9-menu
флоу: полный
Решения: нет

## Критерии закрытия

### 1. Критерий ещё не написан
Критерий пишется после того, как решены развилки обсуждения.

## Оператору

### Где показывать сезонное меню?
Осенью в меню появляются тыквенный латте и глинтвейн без алкоголя. Сейчас их видно только в общем списке напитков, и гости их не замечают.

Место на главной странице есть в двух местах: баннером над меню или отдельной строкой карточек под ним.

- вариант: баннером над меню — сезонное видно сразу, но баннер сдвигает меню вниз
- вариант: строкой карточек под баннером акций — меню остаётся на месте, сезонное видно при прокрутке
- рекомендовано: строкой карточек под баннером акций — меню остаётся на месте, сезонное видно при прокрутке

ответ:

## Агенту

### Критерии
- 1. проверка: будет названа вместе с критерием — где: стадия «Критерий»

### Вопросы

### Факты
- главная страница собирается из блоков в pages/home, баннер акций — блок promo

### Флоу
- [x] 1. Ветка — выход: feat/cafe-9-menu от dev
- [x] 2. Разведка — выход: карта мест в «Фактах»
- [ ] 3. Обсуждение
- [ ] 4. Критерий
- [ ] 5. Реализация
- [ ] 6. Ревью
- [ ] 7. Приёмка
- [ ] 8. Мерж

### Шаги
- [x] вынести развилки оператору — результат: вопрос о месте сезонного меню — проверен: блок в «Оператору»
- [ ] вобрать ответ оператора
"@
    Add-Commit $cafeBase 'Памяти задач'
    $bases.Add($cafeBase)
    foreach ($copy in $cafe.Values) { $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $cafeBase }) }
    $copies.cafe = $cafe

    # «Склад»: задача на ревью, задача на приёмке у оператора и копия, где задача закончилась.
    $stock = New-DemoProject 'stock' 'Склад' ([ordered]@{
            'stock-import' = 'feat/skl-31-import'; 'stock-audit' = 'feat/skl-27-audit'; 'stock-labels' = 'feat/skl-29-labels' })
    $stockBase = Join-Path $basesDir 'stock-knowledge'
    New-DemoBase $stockBase 'Склад' @'
- Учёт остатков на складе кофеен: приход, расход и инвентаризация.
- Кладовщик работает с планшета, управляющий смотрит отчёты с компьютера.
'@ $stock.main @'
# Склад — бэклог

следующий номер: SKL-36
поля: приоритет, тип

## SKL-32 Остаток уходит в минус при одновременном списании

приоритет: блокер
тип: баг

Два кладовщика списывают одно и то же зерно одновременно, и остаток становится отрицательным.

## SKL-33 Отчёт по расходу за месяц в PDF

приоритет: средний
тип: фича

Управляющему нужен отчёт для бухгалтерии, сейчас его собирают из таблицы руками.

## SKL-35 Напоминание, когда молоко заканчивается

приоритет: средний
тип: фича

Кладовщик узнаёт, что молоко кончилось, когда бариста уже пришёл за ним.
'@
    Write-Utf8 (Join-Path $stockBase 'work\stock-import.md') @"
# SKL-31 Импорт накладных из CSV
рабочая копия: $($stock['stock-import'])
ветка: feat/skl-31-import
флоу: полный
Решения: нет

## Критерии закрытия

### 1. Накладная из CSV попадает в приход
Кладовщик выбирает файл накладной поставщика, и её строки встают в приход с количеством и ценой.

### 2. Строка с ошибкой не ломает импорт
Строки, которые не разобрать, показываются списком, а остальные импортируются.

### Не входит
Накладные в Excel.

## Оператору

## Агенту

### Критерии
- 1. проверка: тест импорта на файле поставщика — где: tests/import.test.ts
- 2. проверка: тест импорта на файле с битой строкой — где: tests/import.test.ts

### Вопросы

### Факты
- поставщики присылают CSV с разделителем «;» и десятичной запятой

### Флоу
- [x] 1. Ветка — выход: feat/skl-31-import от dev
- [x] 2. Разведка — выход: карта мест в «Фактах»
- [x] 3. Обсуждение — выход: только CSV, Excel позже
- [x] 4. Критерий — выход: два критерия, ответ оператора «да»
- [x] 5. Реализация — выход: 3 коммита, тесты зелёные
- [ ] 6. Ревью
- [ ] 7. Приёмка
- [ ] 8. Мерж

### Шаги
- [ ] ревью ветки feat/skl-31-import
"@
    Write-Utf8 (Join-Path $stockBase 'work\stock-audit.md') @"
# SKL-27 Инвентаризация по зонам склада
рабочая копия: $($stock['stock-audit'])
ветка: feat/skl-27-audit
флоу: мелкий
Решения: нет

## Критерии закрытия

### 1. Инвентаризацию можно провести по одной зоне
Кладовщик выбирает зону «Холодильник» или «Стеллажи» и пересчитывает только её.

## Оператору

### Инвентаризация по зонам работает — принимаете?
На планшете кладовщика при начале инвентаризации теперь есть выбор зоны. Пересчёт одной зоны занимает минут десять вместо часа. Проверьте на тестовом складе: начните инвентаризацию, выберите «Холодильник» и сверьте остатки.

ответ:

## Агенту

### Критерии
- 1. проверка: e2e инвентаризации зоны — где: e2e/audit.spec.ts

### Вопросы

### Факты
- зоны склада заведены справочником, у каждой позиции своя зона

### Флоу
- [x] 1. Ветка — выход: feat/skl-27-audit от dev
- [x] 2. Реализация — выход: 2 коммита, e2e зелёный
- [ ] 3. Приёмка
- [ ] 4. Мерж

### Шаги
- [x] поднять тестовый склад для приёмки — результат: адрес в вопросе оператору — проверен: страница открывается
- [ ] вобрать ответ оператора
"@
    Add-Commit $stockBase 'Памяти задач'
    $bases.Add($stockBase)
    foreach ($copy in $stock.Values) { $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $stockBase }) }
    $copies.stock = $stock

    # «Блог»: одна задача в самом начале, другая закончилась, основная копия свободна.
    $blog = New-DemoProject 'blog' 'Блог' ([ordered]@{ 'blog-rss' = 'feat/blog-6-rss'; 'blog-authors' = 'feat/blog-4-authors' })
    $blogBase = Join-Path $basesDir 'blog-knowledge'
    New-DemoBase $blogBase 'Блог' @'
- Блог сети кофеен: рецепты, новости и истории поставщиков.
'@ $blog.main @'
# Блог — бэклог

следующий номер: BLOG-8
поля: приоритет, тип

## BLOG-5 Статьи можно искать по тегам

приоритет: средний
тип: фича

Читатель нажимает на тег «рецепты» и видит все рецепты.

## BLOG-7 Картинки в статьях грузятся медленно

приоритет: низкий
тип: баг

Картинки отдаются в полном размере, и на телефоне статья открывается долго.
'@
    Write-Utf8 (Join-Path $blogBase 'work\blog-rss.md') @"
# BLOG-6 Подписка на блог через RSS
рабочая копия: $($blog['blog-rss'])
ветка: feat/blog-6-rss
флоу: мелкий
Решения: нет

## Критерии закрытия

### 1. У блога есть RSS-лента
По адресу /rss.xml отдаются двадцать последних статей с заголовком, датой и первым абзацем.

## Оператору

## Агенту

### Критерии
- 1. проверка: тест ленты на трёх статьях — где: tests/rss.test.ts

### Вопросы

### Факты

### Флоу
- [x] 1. Ветка — выход: feat/blog-6-rss от dev
- [ ] 2. Реализация
- [ ] 3. Приёмка
- [ ] 4. Мерж

### Шаги
- [ ] собрать ленту из последних статей
- [ ] тест ленты
"@
    Add-Commit $blogBase 'Память задачи'
    $bases.Add($blogBase)
    foreach ($copy in $blog.Values) { $links.Add([pscustomobject]@{ path = $copy; status = 'Linked'; base = $blogBase }) }
    $copies.blog = $blog

    # Проверки кита у демонстрации всегда чистые: находок ни у одной базы нет.
    Write-Json (Join-Path $kitDir 'scripts\links.json') $links.ToArray()
    Write-Json (Join-Path $kitDir 'scripts\findings.json') @($bases | ForEach-Object { [pscustomobject]@{ base = $_; findings = @() } })
    Write-Json (Join-Path $panelDir 'bases.json') ([pscustomobject]@{ bases = $bases.ToArray(); kit = $kitDir })
    return [pscustomobject]@{ copies = $copies }
}

# --- то, что живёт только пока панель поднята ---------------------------------------------

# Живые сессии агентов: процессы-пустышки заводятся на каждый запуск, потому что прошлые не
# переживают перезагрузки машины.
function Start-DemoSessions($Copies) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $sessions = @(
        @{ cwd = $Copies.cafe.main; extra = @{ status = 'busy' } }
        @{ cwd = $Copies.cafe.'cafe-loyalty'; extra = @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'c14a7e21'; status = 'busy'; name = 'drive CAFE-14'; startedAt = $now - 40 * 60000 } }
        @{ cwd = $Copies.cafe.'cafe-menu'; extra = @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'c09b3f40'; status = 'waiting'; name = 'drive CAFE-9'; startedAt = $now - 95 * 60000 } }
        @{ cwd = $Copies.cafe.'cafe-receipts'; extra = @{ status = 'idle' } }
        @{ cwd = $Copies.stock.'stock-labels'; extra = @{ status = 'idle' } }
        @{ cwd = $Copies.blog.'blog-rss'; extra = @{ entrypoint = 'cli'; kind = 'bg'; jobId = 'b06e5a17'; status = 'busy'; name = 'drive BLOG-6'; startedAt = $now - 3 * 60000 } }
        @{ cwd = $Copies.blog.'blog-authors'; extra = @{ status = 'idle' } }
        @{ cwd = $Copies.stock.'stock-import'; extra = @{ entrypoint = 'cli'; kind = 'bg'; jobId = 's31d9c02'; status = 'busy'; name = 'drive SKL-31'; startedAt = $now - 15 * 60000 } }
    )
    # Список запусков задач ведёт сама панель — в нём и задачи, запущенные оператором из демонстрации:
    # свои записи скрипт обновляет, а чужие оставляет.
    $file = Join-Path $panelDir 'task-sessions.json'
    $known = if (Test-Path -LiteralPath $file) { try { @((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).sessions) } catch { @() } } else { @() }
    $ours = @($sessions | ForEach-Object { $_.extra.jobId } | Where-Object { $_ })
    $tasks = [Collections.Generic.List[object]]::new()
    foreach ($task in $known) { if ($task -and $task.session -notin $ours) { $tasks.Add($task) } }
    foreach ($session in $sessions) {
        # Копию оператор мог убрать из панели: сессии в каталоге, которого нет, не заводится.
        if (-not (Test-Path -LiteralPath $session.cwd -PathType Container)) { continue }
        $id = Start-Dummy
        Write-Session $sessionsDir $id $session.cwd $session.extra
        if ($session.extra.jobId) { $tasks.Add([pscustomobject]@{ copy = $session.cwd; session = $session.extra.jobId }) }
    }
    # Сессию задачи строка таблицы показывает, только если её запустила панель: этот список запусков
    # панель ведёт сама, и без него фоновые сессии видны лишь в разделе «Сессии».
    Write-Json $file ([pscustomobject]@{ sessions = $tasks.ToArray() })
}

# Журналы расхода за последнюю неделю в формате Claude Code. Пишутся заново на каждый запуск:
# время записей отсчитывается от сейчас, а старше недели «Расход» не смотрит. Случайность с
# постоянным зерном — одни и те же сутки на каждом запуске; тише только выходные, и они сдвигаются
# вместе с сегодняшним днём недели.
function Write-DemoUsage {
    if (Test-Path -LiteralPath $projectsDir) { Remove-Item -LiteralPath $projectsDir -Recurse -Force }
    $random = [Random]::new(112)
    # Доли моделей — шесть к трём к одной.
    $models = @('claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001')
    $projects = @('cafe', 'stock', 'blog')
    # Рабочий день — по часам этой машины: «Расход» раскладывает сутки по её часовому поясу.
    $now = [DateTimeOffset]::Now
    $today = [DateTimeOffset]::new($now.Date, $now.Offset)
    $message = 0
    foreach ($day in 6..0) {
        # Выходной поспокойнее будней: неделя не выглядит ровной полосой.
        $sessionsToday = if ((($now.AddDays(-$day)).DayOfWeek) -in @('Saturday', 'Sunday')) { 1 } else { 3 + $random.Next(3) }
        foreach ($n in 1..$sessionsToday) {
            $project = $projects[$random.Next($projects.Count)]
            $start = $today.AddDays(-$day).AddHours(7 + $random.Next(10)).AddMinutes($random.Next(60))
            if ($start -gt $now) { continue }
            $roll = $random.Next(10)
            $model = if ($roll -lt 6) { $models[0] } elseif ($roll -lt 9) { $models[1] } else { $models[2] }
            $lines = [Collections.Generic.List[string]]::new()
            $at = $start
            foreach ($i in 1..(20 + $random.Next(60))) {
                $at = $at.AddSeconds(20 + $random.Next(160))
                if ($at -gt $now) { break }
                $message++
                $record = [ordered]@{
                    type      = 'assistant'
                    timestamp = $at.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                    requestId = "req_demo_$message"
                    message   = [ordered]@{
                        id    = "msg_demo_$message"
                        model = $model
                        usage = [ordered]@{
                            input_tokens                = 3 + $random.Next(40)
                            output_tokens               = 200 + $random.Next(2500)
                            cache_creation_input_tokens = 500 + $random.Next(6000)
                            cache_read_input_tokens     = 20000 + $random.Next(90000)
                        }
                    }
                }
                $lines.Add(($record | ConvertTo-Json -Depth 5 -Compress))
            }
            if ($lines.Count -eq 0) { continue }
            $file = Join-Path $projectsDir "C--demo-$project\demo-$day-$n.jsonl"
            Write-Utf8 $file (($lines -join "`n") + "`n")
        }
    }
}

# --- запуск ------------------------------------------------------------------------------

$apiPort = $Port + 1
# Демонстрация уже поднята — второй запуск погасил бы её сессии и упал бы на занятом порту.
$busy = @(Get-NetTCPConnection -LocalPort $Port, $apiPort -State Listen -ErrorAction Ignore)
if ($busy.Count) {
    throw "порт $(($busy.LocalPort | Sort-Object -Unique) -join ', ') уже занят — похоже, демонстрация поднята: сначала погасите её"
}

# Без -Rebuild демонстрация собирается, только когда её каталога нет: всё, что в ней сделали, живёт там.
if ($Rebuild -or -not (Test-Path -LiteralPath $Root)) {
    $built = Build-Demo
    $copies = $built.copies
    Write-Host "Демонстрация собрана: $Root"
}
else {
    $known = Read-State
    if (-not $known.copies) {
        throw "не прочитать $state — демонстрацию не поднять такой, какой её оставили; собрать заново: pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'demo.ps1')`" -Rebuild"
    }
    $copies = $known.copies
    Stop-Dummies
    Write-Host "Демонстрация поднята такой, какой её оставили: $Root"
}

Start-DemoSessions $copies
Write-DemoUsage
Write-Json $state ([pscustomobject]@{ copies = $copies; port = $Port })

Write-Host ""
Write-Host "  адрес панели:   http://localhost:$Port   (API рядом, на $apiPort)"
Write-Host "  собрать заново: pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'demo.ps1')`" -Rebuild"
Write-Host ""

if ($NoPanel) { return }

$frontend = Join-Path $repo 'frontend'
if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules'))) {
    throw 'нет node_modules фронта — сначала «npm install» в frontend'
}

# Панель — фронт и API, как в разработке и в песочнице: API на своём порту, dev-сервер фронта — на
# том, который открывают, и он же проксирует на API. Живого панель не видит: всё, что она читает
# и пишет, — в каталоге демонстрации. Ключа доступа там нет, поэтому проценты лимита пустые, а без
# published.json панель не считает себя поставленной и обновлять себя не берётся.
$env:PATH = "$binDir;" + $env:PATH
$api = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-Command',
    "dotnet run --project '$(Join-Path $repo 'backend\src\AgentsKitWeb.Api')' --no-launch-profile -- --urls 'http://localhost:$apiPort' --BasesFile '$(Join-Path $panelDir 'bases.json')' --SessionsDir '$sessionsDir' --ClaudeDir '$claudeDir' --ProjectsDir '$projectsDir' --CredentialsFile '$(Join-Path $Root 'no-credentials.json')' --PublishedFile '$(Join-Path $panelDir 'published.json')'")

try {
    $env:WEB_PORT = "$Port"
    $env:API_PORT = "$apiPort"
    Write-Host "Демонстрационная панель: http://localhost:$Port — гасится Ctrl+C"
    Push-Location $frontend
    npm run dev
}
finally {
    Pop-Location
    # dotnet run держит API отдельным дочерним процессом: гасим всё дерево, а следом пустышки сессий —
    # они заведены отдельно и в дерево не входят.
    & taskkill.exe /PID $api.Id /T /F 2>$null | Out-Null
    Stop-Dummies
}
