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
    [string]$Log,
    # Адреса GitHub и срок, за который должна прийти очередная порция архива, — для проверок скрипта.
    [string]$Api = 'https://api.github.com',
    [string]$Downloads = 'https://github.com',
    [int]$StallSeconds = 60
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
        # Выпуски master — обычные v<номер>, выпуски dev — предварительные v<номер>-dev. Выпуск dev выходит
        # на каждое слияние, и master бывает дальше первой сотни: страницы листаются, пока канал не найден.
        $pattern = if ($Channel -eq 'dev') { '^v(\d+\.\d+\.\d+)-dev$' } else { '^v(\d+\.\d+\.\d+)$' }
        $found = @()
        for ($page = 1; $page -le 5 -and -not $found; $page++) {
            $answer = Invoke-RestMethod "$Api/repos/$Releases/releases?per_page=100&page=$page" `
                -Headers @{ 'User-Agent' = 'agents-kit-web' }
            # Массив ответа приходит одним объектом — foreach его разворачивает.
            $batch = @(foreach ($release in $answer) { $release })
            $found = @($batch | Where-Object { $_.tag_name -match $pattern -and -not $_.draft })
            if ($batch.Count -lt 100) { break }
        }
        $Tag = $found | Sort-Object { [version]($_.tag_name -replace $pattern, '$1') } |
            Select-Object -Last 1 -ExpandProperty tag_name
        if (-not $Tag) { throw "в канале $Channel нет ни одного выпуска" }
    }
    Write-Log "выпуск $Tag"

    # Скачивание — потоком, с отметками хода: архив весит десятки мегабайт, и оператор видит, сколько осталось.
    $response = $client.GetAsync("$Downloads/$Releases/releases/download/$Tag/$Asset",
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $total = [long]$response.Content.Headers.ContentLength
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $file = [IO.File]::Create($archive)
    try {
        $buffer = [byte[]]::new(81920)
        $done = [long]0
        $marked = [Diagnostics.Stopwatch]::StartNew()
        # Срок клиента стережёт только заголовки: оборванная без закрытия связь повесила бы чтение навсегда,
        # а с ним и окно обновления. Каждая порция должна прийти за свой срок.
        $wait = [Threading.CancellationTokenSource]::new()
        Write-Log "[скачано] 0 из $total"
        while ($true) {
            $wait.CancelAfter([TimeSpan]::FromSeconds($StallSeconds))
            try { $read = $source.ReadAsync($buffer, 0, $buffer.Length, $wait.Token).GetAwaiter().GetResult() }
            catch [OperationCanceledException] { throw "скачивание встало: за $StallSeconds с не пришло ни байта" }
            if ($read -le 0) { break }
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
        $wait.Dispose()
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
