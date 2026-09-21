namespace AgentsKitWeb.Api.Usage;

/// <summary>Сколько панель насчитала за окно по журналам. Процент лимита сюда не входит — он приходит от Anthropic.</summary>
public sealed record UsageWindow(DateTimeOffset Since, long Tokens, long Answers);

/// <summary>
/// Доля модели в израсходованном за неделю. Вес — во сколько раз модель тратит лимит быстрее Sonnet;
/// без него доли врут, потому что ответ Opus стоит лимита куда дороже такого же ответа Haiku.
/// </summary>
public sealed record ModelUsage(string Model, long Answers, long Tokens, double Weight, double Share);

/// <summary>
/// Последние сутки как часть недели. Share — доля суток в израсходованном за неделю с весами моделей:
/// лимит тратится по весу, и без него сутки на Opus выглядели бы дешевле, чем обошлись.
/// </summary>
public sealed record UsageDay(DateTimeOffset Since, long Tokens, long Answers, double Share);

/// <summary>Счёт панели по журналам: два окна, последние сутки и разбивка недели по моделям.</summary>
public sealed record UsageTotals(UsageWindow FiveHours, UsageWindow Week, UsageDay Day, IReadOnlyList<ModelUsage> Models);

public static class UsageWeights
{
    /// <summary>
    /// Вес модели берётся из отношения цен: Opus впятеро дороже Sonnet, Haiku втрое дешевле.
    /// Считается по имени, а не по точному списку версий: новая версия той же линейки появляется
    /// без панели, и вес у неё тот же.
    /// </summary>
    public static double Of(string model)
    {
        if (model.Contains("opus", StringComparison.OrdinalIgnoreCase))
            return 5;
        if (model.Contains("haiku", StringComparison.OrdinalIgnoreCase))
            return 0.33;
        return 1;
    }
}

public static class UsageMath
{
    /// <summary>Пятичасовое и недельное окна, последние сутки и доли моделей за неделю — из часовых корзин сканера.</summary>
    public static UsageTotals Sum(IReadOnlyList<UsageBucket> buckets, DateTimeOffset now)
    {
        var fiveHoursSince = now - TimeSpan.FromHours(5);
        var daySince = now - TimeSpan.FromDays(1);
        var weekSince = now - UsageScanner.LongestWindow;

        return new UsageTotals(
            Window(buckets, fiveHoursSince, now),
            Window(buckets, weekSince, now),
            Day(buckets, daySince, weekSince, now),
            Models(buckets, weekSince, now));
    }

    /// <summary>
    /// Корзина часовая, поэтому в окно берутся корзины, начавшиеся не раньше его начала: час, на который
    /// окно легло серединой, целиком не учитывается — иначе расход прошлого окна попал бы в текущее.
    /// </summary>
    private static IEnumerable<UsageBucket> In(IReadOnlyList<UsageBucket> buckets, DateTimeOffset since, DateTimeOffset now) =>
        buckets.Where(bucket => bucket.Hour >= since && bucket.Hour <= now);

    private static UsageWindow Window(IReadOnlyList<UsageBucket> buckets, DateTimeOffset since, DateTimeOffset now)
    {
        var inside = In(buckets, since, now).ToList();
        return new UsageWindow(since, inside.Sum(bucket => bucket.Tokens), inside.Sum(bucket => bucket.Answers));
    }

    // Сутки скользящие, а не календарные: число не обнуляется в полночь — выбор оператора на B-131.
    private static UsageDay Day(IReadOnlyList<UsageBucket> buckets, DateTimeOffset since, DateTimeOffset weekSince, DateTimeOffset now)
    {
        var window = Window(buckets, since, now);
        var day = Weighted(In(buckets, since, now));
        var week = Weighted(In(buckets, weekSince, now));
        return new UsageDay(since, window.Tokens, window.Answers, week > 0 ? day / week : 0);
    }

    private static double Weighted(IEnumerable<UsageBucket> buckets) =>
        buckets.Sum(bucket => bucket.Tokens * UsageWeights.Of(bucket.Model));

    private static IReadOnlyList<ModelUsage> Models(IReadOnlyList<UsageBucket> buckets, DateTimeOffset since, DateTimeOffset now)
    {
        var byModel = In(buckets, since, now)
            .GroupBy(bucket => bucket.Model)
            .Select(group => new
            {
                Model = group.Key,
                Answers = group.Sum(bucket => bucket.Answers),
                Tokens = group.Sum(bucket => bucket.Tokens),
                Weight = UsageWeights.Of(group.Key),
            })
            .ToList();

        var weighted = byModel.Sum(model => model.Tokens * model.Weight);
        return byModel
            // Служебные записи журнала («<synthetic>») токенов не стоят, и строка о них в таблице лишняя.
            .Where(model => model.Tokens > 0)
            .Select(model => new ModelUsage(
                model.Model,
                model.Answers,
                model.Tokens,
                model.Weight,
                weighted > 0 ? model.Tokens * model.Weight / weighted : 0))
            .OrderByDescending(model => model.Share)
            .ToList();
    }
}
