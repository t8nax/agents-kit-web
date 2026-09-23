<#
.SYNOPSIS
Собирает панель из исходников и ставит её — для разработки и приёмки ветки задачи.

.DESCRIPTION
Пользователь ставит и обновляет панель готовой сборкой с GitHub (install.ps1, update.ps1); этот
скрипт — для того, у кого исходники под рукой. Собирает канал (по умолчанию master) или любой ref
во временном git worktree, не трогая рабочую копию, тем же build.ps1, что и сборка выпуска,
и ставит собранное через deploy.ps1: останавливает запущенную панель, подменяет каталог,
регистрирует задачу Планировщика заданий «при входе пользователя» и запускает панель.

Поставленная так панель обновляется кнопкой, как любая другая, — готовой сборкой своего канала.

.EXAMPLE
pwsh -NoProfile -File scripts/publish.ps1

.EXAMPLE
pwsh -NoProfile -File scripts/publish.ps1 -Ref feat/some-task -Target D:\tmp\panel -Port 5099 -TaskName 'akw probe'
#>
param(
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    [string]$Ref,
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = Split-Path $PSScriptRoot -Parent

# Ref задан руками — ставят не канал, а именно его (приёмка ветки задачи), и в published.json
# каналом стоит он сам: иначе панель звала бы веткой задачи чужое имя.
# Отдельная переменная, а не $Channel: ValidateSet проверяет и присваивание.
if ($PSBoundParameters.ContainsKey('Ref')) { $channelName = $Ref }
else {
    $Ref = "origin/$Channel"
    $channelName = $Channel
}

git -C $repo fetch origin
$sha = git -C $repo rev-parse --verify "$Ref^{commit}"
Write-Host "Публикация $Ref ($sha) в $Target"

$work = Join-Path ([IO.Path]::GetTempPath()) "akw-publish-$sha"
# Сборка кладётся рядом с каталогом публикации, чтобы подмена была переносом в пределах одного диска.
$staging = "$Target.new"

try {
    if (Test-Path $work) { git -C $repo worktree remove --force $work }
    git -C $repo worktree add --detach $work $sha

    & (Join-Path $work 'scripts\build.ps1') -Source $work -Output $staging -Channel $channelName -Ref $Ref
    # Постановка — скриптом из worktree, а не из сборки: сборку он сам переносит на место панели.
    & (Join-Path $work 'scripts\deploy.ps1') -Source $staging -Target $Target -Port $Port -TaskName $TaskName
}
finally {
    if (Test-Path $work) { git -C $repo worktree remove --force $work }
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
}
