# Разговор с сессией кита без окна: отдать реплику, получить ответ и номер сессии для следующей.
# Сессия кита только читает и советует: правки кита оператор делает сам, в своей сессии кита.
param(
    [Parameter(Mandatory)] [string] $PromptFile,
    [string] $Resume,
    [string] $Kit = 'D:\Projects\agents-kit'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$role = @'
Тебя спрашивает не оператор, а сессия проекта под китом: она передаёт твой ответ оператору и приносит его ответ обратно.
Ты только читаешь и советуешь. Ничего не правь и не коммить — ни кит, ни что-либо ещё: правки кита оператор делает сам, в своей сессии кита.
Вопросы к оператору ставь последним разделом «Оператору», по вопросу на строку, с вариантами и твоей рекомендацией. Ответ оператора сочинять нельзя: жди его в следующей реплике.
'@

$claudeArgs = @(
    '-p', '--output-format', 'json',
    '--allowedTools', 'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit',
    '--append-system-prompt', $role
)
if ($Resume) { $claudeArgs += @('--resume', $Resume) }

Set-Location $Kit
$raw = Get-Content -Raw -Encoding utf8 $PromptFile | claude @claudeArgs
$reply = $raw | ConvertFrom-Json
"сессия: $($reply.session_id)"
''
$reply.result
