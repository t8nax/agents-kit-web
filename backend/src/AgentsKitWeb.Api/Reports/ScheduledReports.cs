using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Reports;

/// <summary>
/// Строит отчёты о флоу по расписанию проектов: в назначенные дни и час, по часам машины. Флоу и субагенты не менялись
/// с последнего отчёта — разбор не идёт, сдвигается только отметка проверки. Панели в назначенное время не было —
/// пропущенный запуск догоняется одним разом, как только она заработала, — решения оператора на B-270.
/// </summary>
public sealed class ScheduledReports(
    BasesStore bases,
    ReportsStore store,
    FlowReports reports,
    TimeProvider time,
    IConfiguration configuration,
    ILogger<ScheduledReports> logger) : BackgroundService
{
    private TimeSpan Interval => TimeSpan.FromSeconds(configuration.GetValue("ReportScheduleIntervalSeconds", 60));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                // Сначала выдержка: на старте панели сверка баз ещё не прошла, и ошибок во флоу разбор бы не увидел.
                await Task.Delay(Interval, time, stoppingToken);
                try
                {
                    await TickAsync(stoppingToken);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogError(e, "Отчёт о флоу по расписанию не запущен");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>
    /// Один круг: разбор по расписанию заводится для первого проекта, чьё назначенное время прошло и ещё не отработано.
    /// Идёт разбор — круг ждёт: разом идёт одна просьба вида, и новая остановила бы начатую оператором.
    /// </summary>
    public async Task TickAsync(CancellationToken cancellationToken)
    {
        if (reports.Running is not null)
            return;

        var now = time.GetLocalNow();
        foreach (var basePath in bases.List().Where(Directory.Exists))
        {
            var entry = store.Of(basePath, ReportsStore.FlowKind);
            if (!entry.Schedule.Enabled || LastDue(entry.Schedule, now, time.LocalTimeZone) is not { } due)
                continue;
            // Время, назначенное до того, как расписание задали, не отрабатывается: расписание действует с записи.
            if (entry.ScheduledAt is not { } handled || handled >= due)
                continue;

            store.MarkScheduled(basePath, ReportsStore.FlowKind, due);
            var material = await FlowMaterial.ReadAsync(basePath, cancellationToken);
            if (material is not null && entry.Report?.Fingerprint == material.Fingerprint)
            {
                store.MarkChecked(basePath, ReportsStore.FlowKind, now);
                continue;
            }

            var (started, block) = await reports.StartAsync(basePath, cancellationToken);
            if (started is null)
            {
                logger.LogInformation("Отчёт о флоу {Base} по расписанию не построен: {Reason}", basePath, block?.Reason);
                continue;
            }
            return;
        }
    }

    /// <summary>Последнее назначенное время не позже <paramref name="now"/>; null — дней в расписании нет.</summary>
    public static DateTimeOffset? LastDue(ReportSchedule schedule, DateTimeOffset now, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(now, zone);
        for (var back = 0; back <= 7; back++)
        {
            var day = local.Date.AddDays(-back);
            if (!schedule.Days.Contains(day.DayOfWeek))
                continue;
            var at = day.AddHours(schedule.Hour);
            var slot = new DateTimeOffset(at, zone.GetUtcOffset(at));
            if (slot <= now)
                return slot;
        }
        return null;
    }
}
