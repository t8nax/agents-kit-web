<#
.SYNOPSIS
Не пускает в dev и master код, у которого не вырос номер версии панели в version.txt.

.DESCRIPTION
Зовут хуки git из этого каталога; включает их `git config core.hooksPath .githooks` — один раз на репозиторий,
и хуки действуют во всех его рабочих копиях.

Сборка выпуска на GitHub не выпускает номер, уже вышедший в канале, — забытый номер валил выпуск уже после
отправки. Здесь он ловится раньше:
- Merge — слияние в dev на компьютере: номер в результате слияния должен быть больше, чем в dev до него,
  ровно на один шаг — одно число на единицу, правее него нули.
- Push — отправка dev или master: номер в отправляемом должен быть больше, чем уже лежит в этой ветке на сервере.
  Так ловится и то, что попало в dev мимо слияния. Ветки задач отправляются без проверки.

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

# Содержимое version.txt указанного состояния (коммит или «:» — индекс); файла нет — $null.
function Get-Text($revision) {
    $text = git show "${revision}version.txt" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $text) { return $null }
    ($text | Out-String).Trim()
}

# Номер — четыре числа 0.X.Y.Z; до 0.25.0 он был из трёх. Числа номера — четыре, недостающие — нули:
# иначе «0.11» вышло бы меньше «0.11.0». Не номер — $null.
function ConvertTo-Parts($text) {
    $version = $null
    if (-not [version]::TryParse($text, [ref]$version)) { return $null }
    , @($version.Major, $version.Minor, [Math]::Max($version.Build, 0), [Math]::Max($version.Revision, 0))
}

# Номер поднят верно: одно число выросло на единицу, а правее него — нули. Слияние задачи поднимает номер
# на один шаг; отправка канала несёт сразу несколько слияний, и там номер только растёт.
function Test-OneStep($was, $now) {
    for ($i = 0; $i -lt 4; $i++) {
        if ($now[$i] -eq $was[$i]) { continue }
        if ($now[$i] -ne $was[$i] + 1) { return $false }
        for ($j = $i + 1; $j -lt 4; $j++) {
            if ($now[$j] -ne 0) { return $false }
        }
        return $true
    }
    $false
}

# Отказ, если номер не вырос или, с -OneStep, поднят не на один шаг. Прежнего номера нет или он не номер —
# сравнивать не с чем.
function Assert-Grown($where, $wasText, $what, $nowText, $advice, [switch]$OneStep) {
    if (-not $wasText -or -not $nowText) { return }
    $was = ConvertTo-Parts $wasText
    $now = ConvertTo-Parts $nowText
    if (-not $was) { return }
    if (-not $now) {
        [Console]::Error.WriteLine("В version.txt $what не номер версии: «$nowText». Номер пишется как 0.25.1.0.")
        exit 1
    }
    # Номер из четырёх чисел сменил номер из трёх — назад запись не возвращается.
    if ($wasText.Split('.').Count -eq 4 -and $nowText.Split('.').Count -lt 4) {
        [Console]::Error.WriteLine("В version.txt $what номер прежней записи: «$nowText», а $where уже $wasText. Номер пишется четырьмя числами, как 0.25.1.0.")
        exit 1
    }
    $grown = $false
    for ($i = 0; $i -lt 4; $i++) {
        if ($now[$i] -ne $was[$i]) { $grown = $now[$i] -gt $was[$i]; break }
    }
    if (-not $grown) {
        [Console]::Error.WriteLine("Номер версии панели не вырос: $where $wasText, $what $nowText.`n$advice")
        exit 1
    }
    if ($OneStep -and -not (Test-OneStep $was $now)) {
        [Console]::Error.WriteLine("Номер версии панели поднят не на один шаг: $where $wasText, $what $nowText. " +
            "Поднимается одно число на единицу, а числа правее него — нули: ломающее — второе, новое — третье, починка — четвёртое.`n$advice")
        exit 1
    }
}

if ($Mode -eq 'Merge') {
    # Хук слияния зовётся без MERGE_HEAD, поэтому что идёт слияние, решает хук, а не проверка.
    $branch = git symbolic-ref --quiet --short HEAD
    if ($branch -ne 'dev') { exit 0 }

    Assert-Grown 'в dev' (Get-Text 'HEAD:') 'после слияния' (Get-Text ':') `
        'Подними номер в version.txt своим коммитом в ветке задачи — как, сказано в CLAUDE.md.' -OneStep
    exit 0
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

    Assert-Grown "на сервере в $branch" (Get-Text "${remoteSha}:") 'в отправляемом' (Get-Text "${localSha}:") `
        "Подними номер в version.txt своим коммитом и отправь $branch снова — как, сказано в CLAUDE.md."
}
exit 0
