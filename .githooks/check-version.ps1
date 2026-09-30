<#
.SYNOPSIS
Не пускает в dev код, у которого номер выпуска панели в version.txt поднят не по правилу, а в dev и master — код
с номером ниже, чем на сервере.

.DESCRIPTION
Зовут хуки git из этого каталога; включает их `git config core.hooksPath .githooks` — один раз на репозиторий,
и хуки действуют во всех его рабочих копиях.

В version.txt лежит номер выпуска 0.X.Y, четвёртое число — номер сборки Беты — ставит сборка на GitHub.
Номер выпуска поднимает первая задача после выкладки в Стабильный; следующие задачи его не трогают, если
не привозят то, что старше уже набранного, — поломку привычного после одних новинок и починок.
- Merge — слияние в dev на компьютере: номер в результате слияния сверяется с номером в dev до него
  и с последним выпуском Стабильного — наибольшим тегом v<номер> без -dev.
- Push — отправка dev или master: номер в отправляемом не ниже, чем уже лежит в этой ветке на сервере.
  Ветки задач отправляются без проверки.

.EXAMPLE
pwsh -NoProfile -File .githooks/check-version.ps1 -Mode Merge
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet('Merge', 'Push')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
# Отказ по-русски: без этого git покажет его в кодовой странице консоли.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Channels = 'dev', 'master'

# Какое число за что — в каждом отказе: сессия, привыкшая к прежней записи, иначе поднимет не то.
$Rule = 'В version.txt — номер выпуска 0.X.Y: сломано привычное — поднимается второе число, добавлено новое или починено — третье; ' +
    'третье после поднятого второго — ноль. Четвёртое число, номер сборки Беты, ставит сборка на GitHub. ' +
    'Номер выпуска поднимает первая задача после выкладки в Стабильный, следующие — только если привозят поломку привычного, когда поднято одно третье число.'

# Содержимое version.txt указанного состояния (коммит или «:» — индекс); файла нет — $null.
function Get-Text($revision) {
    $text = git show "${revision}version.txt" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $text) { return $null }
    ($text | Out-String).Trim()
}

# Числа номера — всегда четыре, недостающие — нули: иначе «0.11» вышло бы меньше «0.11.0». Не номер — $null.
function ConvertTo-Parts($text) {
    $version = $null
    if (-not [version]::TryParse($text, [ref]$version)) { return $null }
    , @($version.Major, $version.Minor, [Math]::Max($version.Build, 0), [Math]::Max($version.Revision, 0))
}

# Сравнение номеров по числам: -1, 0 или 1.
function Compare-Parts($a, $b) {
    for ($i = 0; $i -lt 4; $i++) {
        if ($a[$i] -ne $b[$i]) { return [Math]::Sign($a[$i] - $b[$i]) }
    }
    0
}

# Номер выпуска — первые три числа; номер сборки Беты отбрасывается.
function Get-Release($parts) { , @($parts[0], $parts[1], $parts[2], 0) }

function Format-Release($parts) { "$($parts[0]).$($parts[1]).$($parts[2])" }


# Последний выпуск Стабильного — наибольший тег v<номер> без -dev; его нет — $null.
function Get-Stable {
    $best = $null
    foreach ($tag in git tag --list 'v*') {
        if ($tag -notmatch '^v(\d+\.\d+\.\d+(?:\.\d+)?)$') { continue }
        $parts = ConvertTo-Parts $Matches[1]
        if (-not $best -or (Compare-Parts $parts $best) -gt 0) { $best = $parts }
    }
    $best
}

function Stop-Merge($message) {
    [Console]::Error.WriteLine("$message $Rule`nПоправь version.txt своим коммитом в ветке задачи — как, сказано в CLAUDE.md.")
    exit 1
}

if ($Mode -eq 'Merge') {
    # Хук слияния зовётся без MERGE_HEAD, поэтому что идёт слияние, решает хук, а не проверка.
    $branch = git symbolic-ref --quiet --short HEAD
    if ($branch -ne 'dev') { exit 0 }

    $wasText = Get-Text 'HEAD:'
    $nowText = Get-Text ':'
    if (-not $wasText -or -not $nowText) { exit 0 }
    $was = ConvertTo-Parts $wasText
    if (-not $was) { exit 0 }
    $now = ConvertTo-Parts $nowText
    if (-not $now -or $nowText.Split('.').Count -ne 3) {
        Stop-Merge "В version.txt после слияния «$nowText», а нужен номер выпуска из трёх чисел."
    }

    # До номера выпуска в version.txt лежал номер из четырёх чисел на каждое слияние: первый номер выпуска
    # только больше его.
    if ($wasText.Split('.').Count -ne 3) {
        if ((Compare-Parts (Get-Release $now) (Get-Release $was)) -le 0) {
            Stop-Merge "Номер выпуска $nowText не больше прежнего номера $wasText в dev."
        }
        exit 0
    }

    $stable = Get-Stable
    $base = if ($stable) { Get-Release $stable } else { $null }
    # Подъём на один шаг: второе число на единицу и третье в ноль или третье на единицу.
    $breaking = @($was[0], ($was[1] + 1), 0, 0)
    $adding = @($was[0], $was[1], ($was[2] + 1), 0)
    $raised = $base -and (Compare-Parts $was $base) -gt 0

    if (-not $raised) {
        # С последней выкладки номер выпуска ещё не поднимали: поднимает эта задача.
        if ((Compare-Parts $now $breaking) -eq 0 -or (Compare-Parts $now $adding) -eq 0) { exit 0 }
        $since = if ($stable) { "в Стабильном последним вышел $(Format-Release $stable)" } else { 'выпусков Стабильного ещё нет' }
        Stop-Merge ("Номер выпуска поднят не так: в dev $wasText, $since, после слияния $nowText. " +
            "Первая задача после выкладки поднимает номер выпуска на один шаг: $(Format-Release $breaking) или $(Format-Release $adding).")
    }

    # Номер выпуска уже поднят: остаётся как есть, а поломка привычного после одного поднятого третьего
    # числа поднимает второе.
    if ((Compare-Parts $now $was) -eq 0) { exit 0 }
    $onlyThird = $was[1] -eq $base[1]
    if ($onlyThird -and (Compare-Parts $now $breaking) -eq 0) { exit 0 }
    $allowed = if ($onlyThird) { "оставить $wasText или, если задача ломает привычное, $(Format-Release $breaking)" } else { "оставить $wasText" }
    Stop-Merge ("Номер выпуска поднят не так: в dev уже $wasText после Стабильного $(Format-Release $stable), после слияния $nowText. " +
        "Нужно $allowed.")
}

# Push: git подаёт строки «<локальная ссылка> <локальный sha> <удалённая ссылка> <удалённый sha>».
$zero = '0' * 40
foreach ($line in [Console]::In.ReadToEnd() -split "`r?`n" | Where-Object { $_ }) {
    $local, $localSha, $remote, $remoteSha = -split $line
    $branch = $remote -replace '^refs/heads/', ''
    if ($branch -notin $Channels) { continue }
    # Удаление ветки, новая ветка на сервере или отправлять нечего — сравнивать не с чем.
    if ($localSha -eq $zero -or $remoteSha -eq $zero -or $localSha -eq $remoteSha) { continue }
    # Серверного коммита у нас нет — git и так откажет: отправка не продолжает то, что на сервере.
    git cat-file -e "$remoteSha^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) { continue }

    $wasText = Get-Text "${remoteSha}:"
    $nowText = Get-Text "${localSha}:"
    if (-not $wasText -or -not $nowText) { continue }
    $was = ConvertTo-Parts $wasText
    if (-not $was) { continue }
    $now = ConvertTo-Parts $nowText
    if (-not $now) {
        [Console]::Error.WriteLine("В version.txt в отправляемом не номер версии: «$nowText». $Rule")
        exit 1
    }
    if ((Compare-Parts (Get-Release $now) (Get-Release $was)) -lt 0) {
        [Console]::Error.WriteLine("Номер выпуска панели ниже, чем на сервере: в $branch там $wasText, в отправляемом $nowText. $Rule")
        exit 1
    }
}
exit 0
