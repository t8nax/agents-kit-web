<#
.SYNOPSIS
Обновляет поставленную панель готовой сборкой с GitHub и ведёт журнал, по которому она рассказывает о ходе.

.DESCRIPTION
Скачивает архив выпуска канала, раскладывает его рядом с каталогом панели и ставит через deploy.ps1.
Ничего не собирает: на компьютере пользователя нет ни исходников, ни инструментов сборки.

Запускается самой панелью и работает уже без неё: постановка гасит панель и подменяет её каталог,
то есть убивает того, кто его позвал. Поэтому панель запускает копию скриптов вне своего каталога,
весь вывод идёт в журнал, а не вызвавшему, и журнал лежит рядом с каталогом панели, а не внутри —
подмена его не сносит.

Ход скачивания — строки «[скачано] <байт> из <байт>», начало постановки — «[ставлю]». Журнал
кончается строкой «[конец] готово …» или «[конец] сорвалось …»; пока конца нет, панель считает
обновление идущим. Обнуляет журнал тот, кто начинает обновление, — скрипт дописывает, чтобы
не затереть строку начала, которую панель успела записать.

.EXAMPLE
pwsh -NoProfile -File update.ps1 -Channel dev -Log C:\...\update.log
#>
param(
    [ValidateSet('master', 'dev')]
    [string]$Channel = 'master',
    # Выпуск, который ставить; не назван — самый свежий выпуск канала.
    [string]$Tag,
    [string]$Releases = 't8nax/agents-kit-web',
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'agents-kit-web\app'),
    [int]$Port = 5080,
    [string]$TaskName = 'agents-kit-web panel',
    [Parameter(Mandatory)]
    [string]$Log
)

$ErrorActionPreference = 'Stop'

$Asset = 'agents-kit-web-win-x64.zip'

function Write-Log($line) { Add-Content -LiteralPath $Log -Value $line }

New-Item -ItemType Directory -Force -Path (Split-Path $Log -Parent) | Out-Null
Write-Log "обновление из канала $Channel, $((Get-Date).ToString('HH:mm:ss'))"

$staging = "$Target.new"
$archive = "$Target.zip"
$client = [Net.Http.HttpClient]::new()
$client.DefaultRequestHeaders.UserAgent.ParseAdd('agents-kit-web')
try {
    if (-not $Tag) {
        # Выпуски master — обычные v<номер>, выпуски dev — предварительные v<номер>-dev.
        $all = Invoke-RestMethod "https://api.github.com/repos/$Releases/releases?per_page=50" -Headers @{ 'User-Agent' = 'agents-kit-web' }
        $pattern = if ($Channel -eq 'dev') { '^v(\d+\.\d+\.\d+)-dev$' } else { '^v(\d+\.\d+\.\d+)$' }
        $Tag = $all | Where-Object { $_.tag_name -match $pattern -and -not $_.draft } |
            Sort-Object { [version]($_.tag_name -replace $pattern, '$1') } |
            Select-Object -Last 1 -ExpandProperty tag_name
        if (-not $Tag) { throw "в канале $Channel нет ни одного выпуска" }
    }
    Write-Log "выпуск $Tag"

    # Скачивание — потоком, с отметками хода: архив весит десятки мегабайт, и оператор видит, сколько осталось.
    $response = $client.GetAsync("https://github.com/$Releases/releases/download/$Tag/$Asset",
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $total = [long]$response.Content.Headers.ContentLength
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $file = [IO.File]::Create($archive)
    try {
        $buffer = [byte[]]::new(81920)
        $done = [long]0
        $marked = [Diagnostics.Stopwatch]::StartNew()
        Write-Log "[скачано] 0 из $total"
        while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $file.Write($buffer, 0, $read)
            $done += $read
            if ($marked.ElapsedMilliseconds -ge 500) {
                Write-Log "[скачано] $done из $total"
                $marked.Restart()
            }
        }
        Write-Log "[скачано] $done из $total"
    }
    finally {
        $file.Dispose()
        $source.Dispose()
    }

    Write-Log '[ставлю]'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    & (Join-Path $PSScriptRoot 'deploy.ps1') -Source $staging -Target $Target -Port $Port -TaskName $TaskName *>&1 |
        ForEach-Object { Write-Log ($_ | Out-String).TrimEnd() }
    $version = (Get-Content (Join-Path $Target 'published.json') -Raw | ConvertFrom-Json).version
    Write-Log "[конец] готово $version"
}
catch {
    Write-Log ($_ | Out-String).TrimEnd()
    Write-Log '[конец] сорвалось'
}
finally {
    $client.Dispose()
    if (Test-Path $archive) { Remove-Item $archive -Force }
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
}
