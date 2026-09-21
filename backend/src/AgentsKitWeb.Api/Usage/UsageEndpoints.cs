namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Окно лимита для панели: свой счёт токенов по журналам и процент лимита от Anthropic.
/// Percent и ResetsAt пустые, когда проценты получить не удалось, — счёт токенов при этом остаётся.
/// </summary>
public sealed record UsageWindowView(
    DateTimeOffset Since,
    long Tokens,
    double Cost,
    int? Percent,
    DateTimeOffset? ResetsAt);

/// <summary>
/// Последние сутки для панели. Процента за сутки Anthropic не присылает, поэтому Percent — оценка
/// из процента недели (UsageMath.DayPercent). Нет процента недели — нет и оценки.
/// </summary>
public sealed record UsageDayView(
    DateTimeOffset Since,
    long Tokens,
    double Cost,
    double? Percent);

/// <summary>
/// Ответ раздела «Расход». LimitsProblem — почему нет процентов; ключа доступа в нём не бывает.
/// PricesDate — на какую дату взяты цены, по которым посчитаны доллары.
/// </summary>
public sealed record UsageView(
    UsageWindowView FiveHours,
    UsageWindowView Week,
    UsageDayView Day,
    IReadOnlyList<ModelUsage> Models,
    string? LimitsProblem,
    DateTimeOffset FetchedAt,
    DateOnly PricesDate);

public static class UsageEndpoints
{
    public static void MapUsageEndpoints(this IEndpointRouteBuilder app)
    {
        // Раздел перечитывается при открытии и по кнопке «Обновить», без таймера: проценты меняются
        // не быстрее, чем идёт работа агентов, а запрос к Anthropic дёргать без нужды незачем.
        app.MapGet("/api/usage", async (UsageScanner scanner, ILimits limits, TimeProvider time, CancellationToken cancellationToken) =>
        {
            var now = time.GetUtcNow();
            var buckets = scanner.Collect();
            var totals = UsageMath.Sum(buckets, now);
            var snapshot = await limits.ReadAsync(cancellationToken);

            return new UsageView(
                Window(totals.FiveHours, snapshot.FiveHours),
                Window(totals.Week, snapshot.Week),
                Day(totals.Day, UsageMath.DayPercent(buckets, now, snapshot.Week)),
                totals.Models,
                snapshot.Problem,
                now,
                UsagePrices.Date);
        });
    }

    private static UsageWindowView Window(UsageWindow window, WindowLimit? limit) =>
        new(window.Since, window.Tokens, window.Cost, limit?.Percent, limit?.ResetsAt);

    private static UsageDayView Day(UsageWindow day, double? percent) =>
        new(day.Since, day.Tokens, day.Cost, percent);
}
