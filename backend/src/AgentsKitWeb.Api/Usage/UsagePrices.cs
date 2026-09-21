using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Цена модели по API-тарифу Anthropic, долларов за миллион токенов. Запись кэша на 5 минут стоит
/// ввод ×1,25, на час — ×2; чтение кэша у модели своё. Fast — во сколько раз дороже быстрый режим.
/// </summary>
public sealed record UsagePrice(string Name, double Input, double Output, double CacheRead, double Fast = 1)
{
    public double CacheWrite5m => Input * 1.25;
    public double CacheWrite1h => Input * 2;

    /// <summary>Сколько стоил бы ответ агента по этой цене.</summary>
    public double Cost(UsageRecord record)
    {
        var cacheWrite5m = record.CacheWrite - record.CacheWrite1h;
        var dollars = (record.Input * Input
                       + record.Output * Output
                       + cacheWrite5m * CacheWrite5m
                       + record.CacheWrite1h * CacheWrite1h
                       + record.CacheRead * CacheRead) / 1_000_000;
        if (record.Fast)
            dollars *= Fast;
        // Вывод только в США Anthropic считает на десятую дороже.
        if (record.UsOnly)
            dollars *= 1.1;
        return dollars;
    }
}

/// <summary>Какой ценой посчитана модель: своей, ценой своей линейки или никакой.</summary>
public sealed record UsagePricing(UsagePrice? Price, bool ByLine);

/// <summary>
/// Прейскурант панели. Цен в журналах нет, поэтому они записаны здесь с датой, на которую взяты,
/// и дата видна в разделе: так устаревший прейскурант заметен, а не врёт молча.
/// Обновляется вместе с панелью — решение оператора на B-182.
/// </summary>
public static partial class UsagePrices
{
    /// <summary>День, когда цены сняты со страницы тарифов Anthropic.</summary>
    public static readonly DateOnly Date = new(2026, 9, 21);

    private static readonly UsagePrice Fable51 = new("Fable 5.1", 10, 50, 0.25);
    private static readonly UsagePrice Mythos51 = new("Mythos 5.1", 10, 50, 0.25);
    private static readonly UsagePrice Opus5 = new("Opus 5", 5, 25, 0.5, Fast: 2);
    private static readonly UsagePrice Sonnet5 = new("Sonnet 5", 2, 10, 0.2);
    private static readonly UsagePrice Haiku45 = new("Haiku 4.5", 1, 5, 0.1);

    /// <summary>Версии, которые Anthropic называет в тарифах, — «линейка-версия» как в имени модели.</summary>
    private static readonly Dictionary<string, UsagePrice> Known = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fable-5-1"] = Fable51,
        ["mythos-5-1"] = Mythos51,
        ["fable-5"] = new("Fable 5", 10, 50, 1),
        ["mythos-5"] = new("Mythos 5", 10, 50, 1),
        ["opus-5"] = Opus5,
        ["opus-4-8"] = new("Opus 4.8", 5, 25, 0.5, Fast: 2),
        ["opus-4-7"] = new("Opus 4.7", 5, 25, 0.5),
        ["opus-4-6"] = new("Opus 4.6", 5, 25, 0.5),
        ["opus-4-5"] = new("Opus 4.5", 5, 25, 0.5),
        ["opus-4-1"] = new("Opus 4.1", 15, 75, 1.5),
        ["opus-4"] = new("Opus 4", 15, 75, 1.5),
        ["sonnet-5"] = Sonnet5,
        ["sonnet-4-6"] = new("Sonnet 4.6", 3, 15, 0.3),
        ["sonnet-4-5"] = new("Sonnet 4.5", 3, 15, 0.3),
        ["sonnet-4"] = new("Sonnet 4", 3, 15, 0.3),
        ["haiku-4-5"] = Haiku45,
        ["haiku-3-5"] = new("Haiku 3.5", 0.8, 4, 0.08),
    };

    /// <summary>
    /// Цена линейки для версии, которой в прейскуранте нет: новая версия выходит без панели,
    /// и считать её по свежей цене своей линейки честнее, чем не считать вовсе.
    /// </summary>
    private static readonly Dictionary<string, UsagePrice> Lines = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fable"] = Fable51,
        ["mythos"] = Mythos51,
        ["opus"] = Opus5,
        ["sonnet"] = Sonnet5,
        ["haiku"] = Haiku45,
    };

    /// <summary>
    /// Цена по имени модели вида claude-opus-4-8 или claude-haiku-4-5-20251001. Версия сверяется
    /// целиком: claude-opus-5-2 — не opus-5, а новая версия, и она идёт по цене линейки.
    /// </summary>
    public static UsagePricing Of(string model)
    {
        var match = Version().Match(model);
        if (match.Success)
        {
            var key = match.Groups["minor"].Success
                ? $"{match.Groups["line"].Value}-{match.Groups["major"].Value}-{match.Groups["minor"].Value}"
                : $"{match.Groups["line"].Value}-{match.Groups["major"].Value}";
            if (Known.TryGetValue(key, out var price))
                return new UsagePricing(price, false);
        }

        foreach (var (line, price) in Lines)
            if (model.Contains(line, StringComparison.OrdinalIgnoreCase))
                return new UsagePricing(price, true);

        return new UsagePricing(null, false);
    }

    // Младший номер — одна-две цифры; восемь цифр после версии — дата выпуска, а не номер.
    [GeneratedRegex(@"(?<line>fable|mythos|opus|sonnet|haiku)-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?!\d)", RegexOptions.IgnoreCase)]
    private static partial Regex Version();
}
