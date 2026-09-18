using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record NewWorkspaceRequest(string? Base, string? Name);

/// <summary>Копия заведена: Name — имя её ветки по словам кита, null — кит его не назвал.</summary>
public sealed record NewWorkspaceResponse(string? Name);

/// <summary>Копия не заведена: Problem — причина, Message — слова кита или путь, о котором речь.</summary>
public sealed record NewWorkspaceRejectedResponse(string Problem, string? Message);

public static class NewWorkspaceProblem
{
    public const string KitNotSet = "kit-not-set";
    public const string KitNotFound = "kit-not-found";
    public const string NoCopy = "no-copy";
    public const string Refused = "refused";
}

public static class NewWorkspaceEndpoints
{
    public static void MapNewWorkspaceEndpoints(this IEndpointRouteBuilder app)
    {
        // Копию заводит скрипт кита, а не свой git: имя, место, ветку и связь с базой проверяет он сам.
        app.MapPost("/api/workspaces", async (NewWorkspaceRequest request, BasesStore bases, CancellationToken cancellationToken) =>
        {
            // Заводится только от базы из списка панели: путь к репозиторию по HTTP не принимается.
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base ?? ""));
            if (basePath is null)
                return Results.NotFound();

            if (bases.Kit() is not { } kit)
                return Rejected(NewWorkspaceProblem.KitNotSet, null);
            var script = KitWorktreeAdd.ScriptFile(kit);
            if (!File.Exists(script))
                return Rejected(NewWorkspaceProblem.KitNotFound, script);

            if (WorkspaceCollector.NewCopySource(WorkspaceCollector.ReadCopies(basePath) ?? []) is not { } copy)
                return Rejected(NewWorkspaceProblem.NoCopy, null);

            var name = string.IsNullOrWhiteSpace(request.Name) ? null : request.Name.Trim();
            var (created, message) = await KitWorktreeAdd.RunAsync(script, copy, name, cancellationToken);
            return created
                ? Results.Ok(new NewWorkspaceResponse(message))
                : Rejected(NewWorkspaceProblem.Refused, message);
        });
    }

    private static IResult Rejected(string problem, string? message) =>
        Results.BadRequest(new NewWorkspaceRejectedResponse(problem, message));
}

/// <summary>Запуск worktree-add.ps1 установленного кита.</summary>
public static class KitWorktreeAdd
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    public static string ScriptFile(string kit) => Path.Combine(kit, "scripts", "worktree-add.ps1");

    // Путь и имя идут переменными окружения, а не строкой команды: так их не нужно экранировать.
    // Отказ кит делает через throw — скрипт печатает сам текст, иначе pwsh отдаёт его в CLIXML.
    private const string Command = """
        $PSStyle.OutputRendering = 'PlainText'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $ErrorActionPreference = 'Stop'
        $a = @{ Path = $env:AKW_COPY }
        if ($env:AKW_NAME) { $a.Name = $env:AKW_NAME }
        try { & $env:AKW_SCRIPT @a 6>&1 | ForEach-Object { "$_" } }
        catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            exit 1
        }
        exit 0
        """;

    /// <summary>
    /// Заводит копию от <paramref name="copy"/>. Заведена — Message: имя ветки из вывода кита;
    /// нет — Message: текст отказа, готовый показать оператору.
    /// </summary>
    public static async Task<(bool Created, string? Message)> RunAsync(
        string script, string copy, string? name, CancellationToken cancellationToken)
    {
        var environment = new Dictionary<string, string>
        {
            ["AKW_SCRIPT"] = script,
            ["AKW_COPY"] = copy,
            ["AKW_NAME"] = name ?? "",
        };
        var run = await KitScriptRunner.RunAsync(Command, environment, Timeout, cancellationToken);
        return run.Outcome switch
        {
            KitRunOutcome.Ok => (true, BranchName(run.Output)),
            KitRunOutcome.NotStarted => (false, "PowerShell (pwsh) не запустился — без него копию не завести"),
            KitRunOutcome.TimedOut => (false, "скрипт кита не ответил за две минуты — проверьте, не осталась ли копия недоделанной"),
            _ => (false, run.Error),
        };
    }

    /// <summary>Имя ветки из строки кита «Ветка: имя»; строки нет — null.</summary>
    public static string? BranchName(string output) =>
        output.Split('\n', StringSplitOptions.TrimEntries)
            .Where(line => line.StartsWith("Ветка:", StringComparison.Ordinal))
            .Select(line => line["Ветка:".Length..].Trim())
            .FirstOrDefault(value => value.Length > 0);
}
