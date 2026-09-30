<#
.SYNOPSIS
Не пускает в dev слияние без фразы оператору — строки «Оператору: …» в сообщении слияния.

.DESCRIPTION
Зовёт хук commit-msg из этого каталога, когда git доводит слияние. Фраза — одна короткая строка о том, что
изменилось для оператора: её карточка «Панель» показывает под сборкой Беты, а у Стабильного — фразы всех его сборок
(scripts/release-notes.ps1). Заголовок слияния остаётся для разработки.

.EXAMPLE
pwsh -NoProfile -File .githooks/check-phrase.ps1 -Message .git/COMMIT_EDITMSG
#>
param(
    [Parameter(Mandatory)]
    [string]$Message
)

$ErrorActionPreference = 'Stop'
# Отказ по-русски: без этого git покажет его в кодовой странице консоли.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$branch = git symbolic-ref --quiet --short HEAD
if ($branch -ne 'dev') { exit 0 }

# Строки-комментарии git вырезает из сообщения сам: фраза в них не считается.
$lines = [IO.File]::ReadAllLines($Message, [Text.UTF8Encoding]::new($false)) | Where-Object { -not $_.StartsWith('#') }
if ($lines | Where-Object { $_ -match '^Оператору:\s*\S' }) { exit 0 }

[Console]::Error.WriteLine(
    "В сообщении слияния в dev нет фразы оператору. Допиши строку «Оператору: <что изменилось для оператора, одной " +
    "короткой фразой>» — её панель показывает под сборкой Беты вместо заголовка слияния. Как, сказано в CLAUDE.md.")
exit 1
