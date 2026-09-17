using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Health;

public static class KitStatus
{
    public const string Ok = "ok";
    public const string NotSet = "not-set";
    public const string NotFound = "not-found";
}

public static class BaseHealthStatus
{
    /// <summary>Проверка прошла; находок может и не быть.</summary>
    public const string Checked = "checked";
    /// <summary>Кит не задан или не найден — проверять нечем.</summary>
    public const string Unchecked = "unchecked";
    /// <summary>База не читается — проверять нечего; причину таблица показывает своей строкой.</summary>
    public const string Unavailable = "unavailable";
    public const string Failed = "failed";
}

/// <summary>Проблема: severity error или warning, file — файл базы, null у связи копии.</summary>
public sealed record HealthProblem(string Severity, string? File, string Message);

public sealed record CopyHealth(string Path, IReadOnlyList<HealthProblem> Problems);

/// <summary>Проблемы одной базы. Error задан у unavailable и failed.</summary>
public sealed record BaseHealth(
    string Base,
    string Project,
    string Status,
    string? Error,
    IReadOnlyList<HealthProblem> Problems,
    IReadOnlyList<CopyHealth> Copies);

/// <summary>Снимок проблем баз. Pending — первая проверка ещё идёт, данных нет.</summary>
public sealed record HealthSnapshot(bool Pending, string Kit, IReadOnlyList<BaseHealth> Bases, DateTimeOffset? CheckedAt);

/// <summary>
/// Проверяет базы в фоне и держит последний снимок. Сверка кита идёт секундами на базу, а таблица
/// опрашивается раз в несколько секунд — поэтому /api/health отдаёт готовый снимок и pwsh не ждёт.
/// Смена списка баз или пути к киту запускает проверку сразу, не дожидаясь интервала.
/// </summary>
public sealed class HealthMonitor(BasesStore store, IKitChecks checks, IConfiguration configuration, ILogger<HealthMonitor> logger)
    : BackgroundService
{
    private volatile HealthSnapshot _snapshot = new(true, KitStatus.NotSet, [], null);
    private readonly SemaphoreSlim _wake = new(0);

    public HealthSnapshot Snapshot => _snapshot;

    private TimeSpan Interval => TimeSpan.FromSeconds(configuration.GetValue("HealthIntervalSeconds", 30));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        store.Changed += Wake;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                // Сигналы, пришедшие до проверки, ею же и покрыты.
                while (_wake.CurrentCount > 0)
                    await _wake.WaitAsync(stoppingToken);
                try
                {
                    _snapshot = await CheckAsync(stoppingToken);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogError(e, "Проверка баз упала");
                }
                await _wake.WaitAsync(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            store.Changed -= Wake;
        }
    }

    private void Wake() => _wake.Release();

    private async Task<HealthSnapshot> CheckAsync(CancellationToken cancellationToken)
    {
        var kit = store.Kit();
        var kitStatus = kit is null ? KitStatus.NotSet : BasesStore.IsKit(kit) ? KitStatus.Ok : KitStatus.NotFound;

        var result = new List<BaseHealth>();
        foreach (var basePath in store.List())
        {
            var rows = await WorkspaceCollector.CollectAsync([basePath], cancellationToken);
            result.Add(await CheckBaseAsync(kitStatus == KitStatus.Ok ? kit : null, basePath, rows, cancellationToken));
        }
        return new HealthSnapshot(false, kitStatus, result, DateTimeOffset.Now);
    }

    private async Task<BaseHealth> CheckBaseAsync(
        string? kit, string basePath, IReadOnlyList<WorkspaceRow> rows, CancellationToken cancellationToken)
    {
        var project = ProjectName.Of(basePath);
        if (!Directory.Exists(basePath) || !File.Exists(Path.Combine(basePath, "agents-kit.json")))
            return new BaseHealth(basePath, project, BaseHealthStatus.Unavailable, "База не читается", [], []);
        if (kit is null)
            return new BaseHealth(basePath, project, BaseHealthStatus.Unchecked, null, [], []);

        // Копии, которых нет на диске, кит называет сам находкой сверки базы.
        var copies = rows.Where(r => r.Error is null && Directory.Exists(r.Path)).Select(r => r.Path).ToList();
        var (check, error) = await checks.RunAsync(kit, basePath, copies, cancellationToken);
        if (check is null)
            return new BaseHealth(basePath, project, BaseHealthStatus.Failed, error, [], []);

        var problems = check.Findings.Select(f => new HealthProblem(Severity(f.Severity), f.File, f.Message)).ToList();
        var copyHealth = copies
            .Select(copy => new CopyHealth(copy, LinkProblems(basePath, check.Links.FirstOrDefault(l => BasesStore.SamePath(l.Path, copy)))))
            .ToList();
        return new BaseHealth(basePath, project, BaseHealthStatus.Checked, null, problems, copyHealth);
    }

    private static string Severity(string kitSeverity) =>
        string.Equals(kitSeverity, "FAIL", StringComparison.OrdinalIgnoreCase) ? "error" : "warning";

    /// <summary>
    /// Состояние связи из цепочки кита словами панели. Сама цепочка — кита: панель только называет,
    /// в каком звене она оборвалась.
    /// </summary>
    public static IReadOnlyList<HealthProblem> LinkProblems(string basePath, KitLinkState? link)
    {
        if (link is null)
            return [new HealthProblem("error", null, "кит не вернул состояние связи копии")];

        var message = link.Status switch
        {
            "Linked" when link.Base is not null && !BasesStore.SamePath(link.Base, basePath) =>
                $"копия связана с другой базой «{link.Base}»",
            "Linked" => null,
            "NotGit" => "каталог копии не в git-репозитории",
            "NoPointer" => "копия не связана с базой: указателя на базу нет",
            "BaseMissing" => $"копия указывает на базу «{link.Base}», а её нет на диске",
            "NotBase" => $"копия указывает на «{link.Base}», а это не база кита",
            "Unlisted" when link.Base is not null && !BasesStore.SamePath(link.Base, basePath) =>
                $"копия указывает на другую базу «{link.Base}», и та её своей не числит",
            "Unlisted" => "база не числит эту копию своей",
            var other => $"неизвестное состояние связи «{other}»",
        };
        return message is null ? [] : [new HealthProblem("error", null, message)];
    }
}
