<#
.SYNOPSIS
Обновляет поставленную панель и ведёт журнал, по которому она рассказывает о ходе.

.DESCRIPTION
Запускается самой панелью и работает уже без неё: publish.ps1 гасит панель и подменяет
её каталог, то есть убивает того, кто его позвал. Поэтому весь вывод идёт в журнал, а не
вызвавшему, и журнал лежит рядом с каталогом панели, а не внутри — подмена его не сносит.

Журнал кончается строкой «[конец] готово …» или «[конец] сорвалось …»; пока конца нет, панель
считает обновление идущим. Обнуляет журнал тот, кто начинает обновление, — скрипт дописывает,
чтобы не затереть строку начала, которую панель успела записать.

.EXAMPLE
pwsh -NoProfile -File scripts/update.ps1 -Channel dev -Log C:\...\update.log
#>
param(
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel',
    [Parameter(Mandatory)]
    [string]$Log
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path (Split-Path $Log -Parent) | Out-Null
Add-Content -LiteralPath $Log -Value "публикация канала $Channel, $((Get-Date).ToString('HH:mm:ss'))"

try {
    & (Join-Path $PSScriptRoot 'publish.ps1') -Channel $Channel -Target $Target -Port $Port -TaskName $TaskName *>&1 |
        ForEach-Object { Add-Content -LiteralPath $Log -Value ($_ | Out-String).TrimEnd() }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "публикация вернула код $LASTEXITCODE" }
    $version = (Get-Content (Join-Path $Target 'published.json') -Raw | ConvertFrom-Json).version
    Add-Content -LiteralPath $Log -Value "[конец] готово $version"
}
catch {
    Add-Content -LiteralPath $Log -Value ($_ | Out-String).TrimEnd()
    Add-Content -LiteralPath $Log -Value '[конец] сорвалось'
}
