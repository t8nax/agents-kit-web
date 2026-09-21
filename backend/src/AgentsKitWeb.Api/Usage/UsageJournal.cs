using System.Text.Json;

namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Расход одного ответа агента: когда он получен, какой моделью и сколько токенов стоил.
/// Формат журнала чужой — панель его только читает и на неизвестные поля не опирается.
/// CacheWrite1h — часть записи кэша на час: она дороже пятиминутной. Fast — быстрый режим,
/// UsOnly — вывод только в США; оба меняют цену ответа. Id — чей это ответ: Claude Code пишет
/// один ответ несколькими строками с одним и тем же расходом, и считать его надо один раз.
/// </summary>
public sealed record UsageRecord(
    DateTimeOffset At,
    string Model,
    long Input,
    long Output,
    long CacheWrite,
    long CacheRead,
    long CacheWrite1h = 0,
    bool Fast = false,
    bool UsOnly = false,
    string? Id = null)
{
    public long Tokens => Input + Output + CacheWrite + CacheRead;
}

/// <summary>Разбор строк журнала сессии Claude Code — файла &lt;сессия&gt;.jsonl.</summary>
public static class UsageJournal
{
    /// <summary>Модель, которую журнал не назвал: показывать строку всё равно надо.</summary>
    public const string UnknownModel = "неизвестная модель";

    /// <summary>
    /// Расход из строки журнала; null — строка не про расход. Расход записан у ответов агента
    /// в message.usage; у записей субагентов он такой же и тоже считается — они идут из того же лимита.
    /// </summary>
    public static UsageRecord? Parse(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
            return null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            // Оборванная строка бывает у журнала сессии, которая пишет прямо сейчас.
            return null;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;

            if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)
                return null;
            if (!message.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
                return null;

            if (!root.TryGetProperty("timestamp", out var timestamp) ||
                timestamp.ValueKind != JsonValueKind.String ||
                !DateTimeOffset.TryParse(timestamp.GetString(), out var at))
                return null;

            var model = message.TryGetProperty("model", out var modelValue) && modelValue.ValueKind == JsonValueKind.String
                ? modelValue.GetString()!
                : UnknownModel;

            var cacheWrite = Number(usage, "cache_creation_input_tokens");
            // Разбивки записи кэша по сроку может не быть — тогда вся запись считается пятиминутной.
            var cacheWrite1h = usage.TryGetProperty("cache_creation", out var cacheCreation) && cacheCreation.ValueKind == JsonValueKind.Object
                ? Math.Min(Number(cacheCreation, "ephemeral_1h_input_tokens"), cacheWrite)
                : 0;

            return new UsageRecord(
                at.ToUniversalTime(),
                model,
                Number(usage, "input_tokens"),
                Number(usage, "output_tokens"),
                cacheWrite,
                Number(usage, "cache_read_input_tokens"),
                cacheWrite1h,
                Text(usage, "speed") == "fast",
                Text(usage, "inference_geo") == "us",
                // Часть ответа — размышление, текст, вызов инструмента — идёт своей строкой с тем же id.
                Text(message, "id") ?? Text(root, "requestId"));
        }
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>Целое поле usage; нет поля или оно не число — ноль: чужой формат может его и не писать.</summary>
    private static long Number(JsonElement usage, string name) =>
        usage.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? number
            : 0;
}
