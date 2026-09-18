using System.Net.Http.Headers;
using System.Text.Json;

namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Проценты лимита из учётной записи оператора. Панель спрашивает их так же, как Claude Code:
/// его собственным адресом и ключом доступа из его профиля — решение оператора на B-60.
/// Способ неопубликован и может измениться, поэтому любой сбой становится строкой для оператора,
/// а не пустыми числами. Ключ доступа в эту строку не попадает никогда.
/// </summary>
public sealed class AnthropicLimits(HttpClient http, ClaudeCredentials credentials, IConfiguration configuration)
    : ILimits
{
    public const string DefaultUrl = "https://api.anthropic.com/api/oauth/usage";

    /// <summary>
    /// Запрос представляется так же, как Claude Code: адрес отвечает его клиенту, и чужим
    /// представляться незачем. Версия в подписи стареет без вреда — на ответ она не влияет.
    /// </summary>
    private const string UserAgent = "claude-cli (external, cli)";

    public async Task<LimitsSnapshot> ReadAsync(CancellationToken cancellationToken)
    {
        var token = credentials.AccessToken();
        if (token is null)
            return LimitsSnapshot.Failed("Панель не нашла ключ доступа в профиле Claude Code — похоже, в нём не выполнен вход.");

        using var request = new HttpRequestMessage(HttpMethod.Get, configuration["UsageLimitsUrl"] ?? DefaultUrl);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, cancellationToken);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return LimitsSnapshot.Failed("Anthropic не ответил вовремя.");
        }
        catch (HttpRequestException)
        {
            // Текст исключения сюда не попадает: в нём бывает и адрес запроса, и заголовки.
            return LimitsSnapshot.Failed("Связаться с Anthropic не удалось.");
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
                return LimitsSnapshot.Failed(response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                    ? "Anthropic не принял ключ доступа — возможно, он протух: войдите в Claude Code заново."
                    : $"Anthropic ответил {(int)response.StatusCode}.");

            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            return Parse(body);
        }
    }

    /// <summary>
    /// Разбор ответа. Проценты лежат в five_hour и seven_day, а тот же набор дублируется списком
    /// limits с видами session и weekly_all — из него берём, когда первых полей в ответе не оказалось.
    /// </summary>
    public static LimitsSnapshot Parse(string body)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            return LimitsSnapshot.Failed("Ответ Anthropic не разобрать — похоже, способ запроса изменился.");
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return LimitsSnapshot.Failed("Ответ Anthropic не разобрать — похоже, способ запроса изменился.");

            var fiveHours = Window(root, "five_hour") ?? FromList(root, "session");
            var week = Window(root, "seven_day") ?? FromList(root, "weekly_all");

            return fiveHours is null && week is null
                ? LimitsSnapshot.Failed("В ответе Anthropic не нашлось процентов — похоже, способ запроса изменился.")
                : new LimitsSnapshot(fiveHours, week, null);
        }
    }

    /// <summary>Окно из поля верхнего уровня: utilization в процентах и resets_at.</summary>
    private static WindowLimit? Window(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var window) || window.ValueKind != JsonValueKind.Object)
            return null;
        if (!window.TryGetProperty("utilization", out var utilization) || utilization.ValueKind != JsonValueKind.Number)
            return null;

        return new WindowLimit(Percent(utilization.GetDouble()), Moment(window, "resets_at"));
    }

    /// <summary>Окно из списка limits — запасной путь: у его записей процент лежит в percent.</summary>
    private static WindowLimit? FromList(JsonElement root, string kind)
    {
        if (!root.TryGetProperty("limits", out var limits) || limits.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var limit in limits.EnumerateArray())
        {
            if (limit.ValueKind != JsonValueKind.Object)
                continue;
            if (!limit.TryGetProperty("kind", out var limitKind) || limitKind.GetString() != kind)
                continue;
            if (!limit.TryGetProperty("percent", out var percent) || percent.ValueKind != JsonValueKind.Number)
                continue;

            return new WindowLimit(Percent(percent.GetDouble()), Moment(limit, "resets_at"));
        }

        return null;
    }

    private static int Percent(double utilization) => (int)Math.Round(Math.Clamp(utilization, 0, 999));

    private static DateTimeOffset? Moment(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String &&
        DateTimeOffset.TryParse(value.GetString(), out var moment)
            ? moment
            : null;
}
