<#
.SYNOPSIS
Перечень задач, приехавших в канал с выпуском: строка «- <задача>» на задачу, новые первыми.

.DESCRIPTION
Зовёт сборка выпуска на GitHub. Выпуск считается от прошлого выпуска того же канала — наибольшего
тега канала, достижимого из выпускаемого кода, — а первого выпуска канала — от начала истории,
но не больше полусотни задач. Этот перечень карточка «Панель» показывает под номером выпуска.

Идут первые родители: так работа приезжает в канал, а слияние, которым задача подтянула канал
к себе перед мержем, лежит в стороне от этой череды. Пачку «Merge dev into master» скрипт
разворачивает в задачи, которые она привезла, а приставку «Merge <ветка>: » срезает.

.EXAMPLE
pwsh -NoProfile -File scripts/release-notes.ps1 -Channel dev
#>
param(
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    [string]$Head = 'HEAD',
    [string]$Repository = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
# Заголовки задач русские: без этого вывод git читается в кодовой странице консоли и бьётся.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Больше полусотни задач в одном выпуске не перечисляем: перечень всё равно не читают.
$Limit = 50
$separator = [char]0x1f

# Тег выпуска master — v<номер>, выпуска dev — v<номер>-dev.
$pattern = if ($Channel -eq 'dev') { '^v(\d+\.\d+\.\d+)-dev$' } else { '^v(\d+\.\d+\.\d+)$' }
$previous = git -C $Repository tag --list 'v*' --merged $Head |
    Where-Object { $_ -match $pattern } |
    Sort-Object { [version]($_ -replace $pattern, '$1') } |
    Select-Object -Last 1

function Get-FirstParent($range) {
    git -C $Repository log --first-parent -n $Limit "--format=%H$separator%P$separator%s" $range |
        Where-Object { $_ } |
        ForEach-Object {
            $parts = $_ -split $separator
            [pscustomobject]@{ Sha = $parts[0]; Parents = @($parts[1] -split ' ' | Where-Object { $_ }); Title = $parts[2] }
        }
}

# Слияние, чей заголовок git написал сам, — «Merge dev into master», «Merge branch …»: оператору оно не говорит ничего.
function Test-Mechanical($title) {
    $title.StartsWith('Merge branch ') -or $title.StartsWith('Merge remote-tracking branch ') -or
        ($title.StartsWith('Merge ') -and $title.Contains(' into ') -and -not $title.Contains(': '))
}

# «Merge fix/some-task: что сделано» — остаётся только фраза о правке. Имя ветки — одно слово.
function Get-Arrived($title) {
    if (-not $title.StartsWith('Merge ')) { return $title }
    $colon = $title.IndexOf(': ')
    if ($colon -gt 6 -and -not $title.Substring(6, $colon - 6).Contains(' ')) { return $title.Substring($colon + 2) }
    $title
}

$range = if ($previous) { "$previous..$Head" } else { $Head }
$arrived = foreach ($commit in Get-FirstParent $range) {
    if (-not (Test-Mechanical $commit.Title)) {
        Get-Arrived $commit.Title
        continue
    }
    if ($commit.Parents.Count -lt 2) { continue }
    Get-FirstParent "$($commit.Parents[0])..$($commit.Parents[1])" |
        Where-Object { -not (Test-Mechanical $_.Title) } |
        ForEach-Object { Get-Arrived $_.Title }
}

$arrived | Select-Object -First $Limit | ForEach-Object { "- $_" }
