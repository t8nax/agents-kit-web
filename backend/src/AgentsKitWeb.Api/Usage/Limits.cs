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

/// <summary>
/// Пока панель не умеет спрашивать проценты: адрес запроса известен, а формат ответа — ещё нет,
/// и выдумывать его сессия не стала. Раздел в этом состоянии показывает свой счёт токенов
/// и строку отказа — тот же вид, что и при отказе Anthropic.
/// </summary>
public sealed class PendingLimits : ILimits
{
    public const string Problem = "Панель ещё не умеет спрашивать проценты лимита у Anthropic.";

    public Task<LimitsSnapshot> ReadAsync(CancellationToken cancellationToken) =>
        Task.FromResult(LimitsSnapshot.Failed(Problem));
}
