using System.Text.Json;

namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Ключ доступа Claude Code из профиля оператора. Панель берёт его только на время запроса о лимитах:
/// наружу он не отдаётся, в журналы не пишется и в текст ошибки не попадает — решение оператора на B-60.
/// Поэтому у этого типа нет ни ToString с ключом, ни свойства, которое вернуло бы его целиком куда-то ещё.
/// </summary>
public sealed class ClaudeCredentials(string file)
{
    public static string DefaultFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", ".credentials.json");

    /// <summary>Ключ доступа; null — файла нет, он испорчен или ключа в нём не записано.</summary>
    public string? AccessToken()
    {
        string text;
        try
        {
            text = File.ReadAllText(file);
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return null;
            if (!document.RootElement.TryGetProperty("claudeAiOauth", out var oauth) ||
                oauth.ValueKind != JsonValueKind.Object)
                return null;
            if (!oauth.TryGetProperty("accessToken", out var token) || token.ValueKind != JsonValueKind.String)
                return null;

            var value = token.GetString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Есть ли в профиле ключ вообще — этим отличается «не вошли в Claude Code» от отказа Anthropic.</summary>
    public bool Present => AccessToken() is not null;
}
