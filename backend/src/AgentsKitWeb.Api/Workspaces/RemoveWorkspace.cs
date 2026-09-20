using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record RemoveWorkspaceRequest(string? Base, string? Copy);

/// <summary>Копия не удалена: Problem — причина, Message — слова кита или путь, о котором речь.</summary>
public sealed record RemoveWorkspaceRejectedResponse(string Problem, string? Message);

public static class RemoveWorkspaceProblem
{
    public const string KitNotSet = "kit-not-set";
    public const string KitNotFound = "kit-not-found";

    /// <summary>В копии идёт задача: её память живёт в базе, и панель её не убирает.</summary>
    public const string InWork = "in-work";

    /// <summary>Основная копия проекта: её кит не удаляет, и от неё же заводит новые.</summary>
    public const string MainCopy = "main-copy";
    public const string Refused = "refused";
}

public static class RemoveWorkspaceEndpoints
{
    public static void MapRemoveWorkspaceEndpoints(this IEndpointRouteBuilder app)
    {
        // Копию сносит скрипт кита, а не свой git: что можно удалять и что станет с веткой, решает он —
        // решение оператора на B-55.
        app.MapPost("/api/workspace/remove", async (
            RemoveWorkspaceRequest request,
            BasesStore bases,
            CancellationToken cancellationToken) =>
        {
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base ?? ""));
            if (basePath is null)
                return Results.NotFound();

            // Копия берётся из тех же строк, что и таблица: путь из запроса сам по себе прав не даёт.
            var rows = await WorkspaceCollector.CollectAsync([basePath], cancellationToken);
            var wanted = WorkspaceCollector.Normalize(request.Copy ?? "");
            var row = rows.FirstOrDefault(r => r.Error is null
                && WorkspaceCollector.Normalize(r.Path).Equals(wanted, StringComparison.OrdinalIgnoreCase));
            if (row is null)
                return Results.NotFound();

            // Занятость и основную копию панель проверяет сама, не дожидаясь отказа кита: пункт меню
            // у таких строк не нажимается, и запрос на них приходить не должен.
            if (row.CopiesDir is not null)
                return Results.Conflict(new RemoveWorkspaceRejectedResponse(RemoveWorkspaceProblem.MainCopy, null));
            if (row.Status != WorkspaceStatus.Free)
                return Results.Conflict(new RemoveWorkspaceRejectedResponse(RemoveWorkspaceProblem.InWork, null));

            if (bases.Kit() is not { } kit)
                return Rejected(RemoveWorkspaceProblem.KitNotSet, null);
            var script = KitWorktreeRemove.ScriptFile(kit);
            if (!File.Exists(script))
                return Rejected(RemoveWorkspaceProblem.KitNotFound, script);

            var (removed, message) = await KitWorktreeRemove.RunAsync(script, row.Path, cancellationToken);
            return removed
                ? Results.NoContent()
                : Rejected(RemoveWorkspaceProblem.Refused, message);
        });
    }

    private static IResult Rejected(string problem, string? message) =>
        Results.BadRequest(new RemoveWorkspaceRejectedResponse(problem, message));
}

/// <summary>Запуск worktree-remove.ps1 установленного кита.</summary>
public static class KitWorktreeRemove
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    public static string ScriptFile(string kit) => Path.Combine(kit, "scripts", "worktree-remove.ps1");

    // Путь идёт переменной окружения, а не строкой команды: так его не нужно экранировать.
    // Отказ кит делает через throw — скрипт печатает сам текст, иначе pwsh отдаёт его в CLIXML.
    private const string Command = """
        $PSStyle.OutputRendering = 'PlainText'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $ErrorActionPreference = 'Stop'
        try { & $env:AKW_SCRIPT -Path $env:AKW_COPY 6>&1 | ForEach-Object { "$_" } }
        catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            exit 1
        }
        exit 0
        """;

    /// <summary>
    /// Убирает копию <paramref name="copy"/>. Не убрана — Message: текст отказа, готовый показать
    /// оператору. Удачный вывод кита панель не разбирает: про оставшуюся ветку окно сказало заранее.
    /// </summary>
    public static async Task<(bool Removed, string? Message)> RunAsync(
        string script, string copy, CancellationToken cancellationToken)
    {
        var environment = new Dictionary<string, string>
        {
            ["AKW_SCRIPT"] = script,
            ["AKW_COPY"] = copy,
        };
        // Кит отказывается удалять копию, внутри которой его запустили, а Windows и так не отдаёт
        // каталог, где стоит процесс: рабочий каталог берётся заведомо снаружи копии.
        var run = await KitScriptRunner.RunAsync(
            Command, environment, Timeout, cancellationToken, workingDirectory: Path.GetTempPath());
        return run.Outcome switch
        {
            KitRunOutcome.Ok => (true, null),
            KitRunOutcome.NotStarted => (false, "PowerShell (pwsh) не запустился — без него копию не убрать"),
            KitRunOutcome.TimedOut => (false, "скрипт кита не ответил за две минуты — проверьте, осталась ли копия на диске"),
            _ => (false, run.Error),
        };
    }
}
