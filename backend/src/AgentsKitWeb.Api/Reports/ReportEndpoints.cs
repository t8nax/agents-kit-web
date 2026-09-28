using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Reports;

/// <summary>Отчёт, каким его показывает раздел: с кольцами, посчитанными панелью.</summary>
public sealed record FlowReportView(
    DateTimeOffset Built,
    DateTimeOffset Checked,
    IReadOnlyList<RingScore> Rings,
    IReadOnlyList<Requirement> Requirements,
    IReadOnlyList<ReportFinding> Findings,
    IReadOnlyList<ReportDiscussion> Discussions);

/// <summary>Отчёт о флоу одного проекта в разделе «Отчёты». Blocked задан — новый отчёт сейчас не строится.</summary>
public sealed record FlowReportItem(
    string Base, string Project, ReportSchedule Schedule, FlowReportView? Report, ReportBlock? Blocked);

public sealed record FlowReportRunRequest(string? Base);

public sealed record FlowReportScheduleRequest(string? Base, bool Enabled, IReadOnlyList<DayOfWeek>? Days, int Hour);

public static class ReportEndpoints
{
    public static void MapReportEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/reports/flow", (BasesStore bases, ReportsStore store, FlowReports reports) =>
            bases.List()
                .Where(Directory.Exists)
                .Select(basePath =>
                {
                    var entry = store.Of(basePath, ReportsStore.FlowKind);
                    // Ошибки сверки во флоу прячут и прошлый отчёт: он не показывается под сообщением — ответ оператора на B-270.
                    var blocked = reports.Blocked(basePath);
                    return new FlowReportItem(
                        basePath,
                        ProjectName.Of(basePath),
                        entry.Schedule,
                        blocked?.Kind == "health" || entry.Report is not { } report ? null : View(report),
                        blocked);
                })
                .ToList());

        app.MapPost("/api/reports/flow/run", async (
            FlowReportRunRequest request, BasesStore bases, FlowReports reports, CancellationToken cancellationToken) =>
        {
            if (Listed(bases, request.Base) is not { } basePath)
                return Results.NotFound();

            var (started, block) = await reports.StartAsync(basePath, cancellationToken);
            return started is null ? Results.Conflict(block) : Results.Ok(started.Summary);
        });

        app.MapPut("/api/reports/flow/schedule", (FlowReportScheduleRequest request, BasesStore bases, ReportsStore store) =>
        {
            if (Listed(bases, request.Base) is not { } basePath)
                return Results.NotFound();
            var schedule = new ReportSchedule(request.Enabled, request.Days ?? [], request.Hour);
            if (!schedule.IsValid)
                return Results.BadRequest();

            store.SaveSchedule(basePath, ReportsStore.FlowKind, schedule);
            return Results.Ok(store.Of(basePath, ReportsStore.FlowKind).Schedule);
        });
    }

    public static FlowReportView View(FlowReport report) => new(
        report.Built,
        report.Checked,
        FlowReportScores.Of(report.Requirements, report.Findings),
        report.Requirements,
        report.Findings,
        report.Discussions);

    /// <summary>База из списка панели: запрос не должен уметь назвать произвольный каталог.</summary>
    private static string? Listed(BasesStore bases, string? basePath) =>
        basePath is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath) && Directory.Exists(b));
}
