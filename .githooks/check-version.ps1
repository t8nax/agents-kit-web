<#
.SYNOPSIS
Не пускает в dev и master код, у которого не вырос номер версии панели в version.txt.

.DESCRIPTION
Зовут хуки git из этого каталога; включает их `git config core.hooksPath .githooks` — один раз на репозиторий,
и хуки действуют во всех его рабочих копиях.

Сборка выпуска на GitHub не выпускает номер, уже вышедший в канале, — забытый номер валил выпуск уже после
отправки. Здесь он ловится раньше:
- Merge — слияние в dev на компьютере: номер в результате слияния должен быть больше, чем в dev до него.
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

# Номер из version.txt указанного состояния (коммит или «:» — индекс); файла нет — $null.
function Get-Version($revision) {
    $text = git show "${revision}version.txt" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $text) { return $null }
    [version](($text | Out-String).Trim())
}

function Stop-Unchanged($where, $was, $what, $now) {
    [Console]::Error.WriteLine(
        "Номер версии панели не вырос: $where $was, $what $now.`n" +
        "Подними номер в version.txt своим коммитом в ветке задачи — как, сказано в CLAUDE.md.")
    exit 1
}

if ($Mode -eq 'Merge') {
    # Хук слияния зовётся без MERGE_HEAD, поэтому что идёт слияние, решает хук, а не проверка.
    $branch = git symbolic-ref --quiet --short HEAD
    if ($branch -ne 'dev') { exit 0 }

    $was = Get-Version 'HEAD:'
    $now = Get-Version ':'
    if ($was -and $now -and $now -le $was) { Stop-Unchanged 'в dev' $was 'после слияния' $now }
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

    $was = Get-Version "${remoteSha}:"
    $now = Get-Version "${localSha}:"
    if ($was -and $now -and $now -le $was) { Stop-Unchanged "на сервере в $branch" $was 'в отправляемом' $now }
}
exit 0
