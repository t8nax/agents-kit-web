namespace AgentsKitWeb.Api.Usage;

/// <summary>Сколько процентов окна израсходовано и когда оно сбросится — так это приходит от Anthropic.</summary>
public sealed record WindowLimit(int Percent, DateTimeOffset? ResetsAt);

/// <summary>
/// Проценты лимита по учётной записи оператора. Problem — почему их нет: строка показывается оператору,
/// поэтому ключа доступа в ней не бывает, даже когда отказ пришёл именно из-за ключа.
/// </summary>
public sealed record LimitsSnapshot(WindowLimit? FiveHours, WindowLimit? Week, string? Problem)
{
    public static LimitsSnapshot Failed(string problem) => new(null, null, problem);
}

/// <summary>Откуда панель берёт проценты лимита.</summary>
public interface ILimits
{
    Task<LimitsSnapshot> ReadAsync(CancellationToken cancellationToken);
}
