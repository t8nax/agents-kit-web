using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Panel;

/// <summary>Выпуск канала на GitHub: номер, тег, по которому его скачивают, и задачи, приехавшие с ним.</summary>
public sealed record PanelRelease(string Version, string Tag, IReadOnlyList<string> Tasks);

/// <summary>
/// Что в канале есть сверх стоящей панели. Latest — номер самого свежего выпуска канала, null — выпусков
/// в канале нет. Releases — выпуски новее стоящей панели, новые первыми: панель сравнивает себя
/// с каналом по номеру, а номер поднимает агент при слиянии, и повтор номера сборка на GitHub не выпускает.
/// </summary>
public sealed record PanelUpdate(string? Latest, IReadOnlyList<PanelRelease> Releases);

/// <summary>Выпуски канала, свежие первыми; null — GitHub не ответил, и сравнить сейчас не с чем.</summary>
public interface IPanelReleases
{
    Task<IReadOnlyList<PanelRelease>?> ReadAsync(string repository, string channel, CancellationToken cancellationToken);
}

public static class PanelUpdates
{
    /// <summary>Репозиторий выпусков, если сборка его не назвала: сборка из исходников до этой правки.</summary>
    public const string DefaultRepository = "t8nax/agents-kit-web";

    public static PanelUpdate Newer(IReadOnlyList<PanelRelease> releases, string installed)
    {
        var standing = Number(installed);
        return new PanelUpdate(
            releases.FirstOrDefault()?.Version,
            releases.Where(release => standing is null || Number(release.Version) > standing).ToList());
    }

    public static Version? Number(string version) =>
        Version.TryParse(version.Split('-', '+')[0], out var number) ? number : null;
}

/// <summary>
/// Выпуски канала со страницы выпусков GitHub. Без ключа GitHub отвечает шестьдесят раз в час, а карточку
/// открывают и обновляют кнопкой, поэтому ответ держится пару минут.
/// </summary>
public sealed partial class GitHubReleases(IHttpClientFactory clients, TimeProvider time) : IPanelReleases
{
    public const string Client = "github";

    private static readonly TimeSpan Fresh = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, IReadOnlyList<PanelRelease> Releases)> _cache = new();

    public async Task<IReadOnlyList<PanelRelease>?> ReadAsync(
        string repository, string channel, CancellationToken cancellationToken)
    {
        var key = $"{repository}|{channel}";
        if (_cache.TryGetValue(key, out var cached) && time.GetUtcNow() - cached.At < Fresh)
            return cached.Releases;

        try
        {
            using var response = await clients.CreateClient(Client)
                .GetAsync($"repos/{repository}/releases?per_page=50", cancellationToken);
            if (!response.IsSuccessStatusCode)
                return null;
            var releases = Parse(await response.Content.ReadAsStringAsync(cancellationToken), channel);
            _cache[key] = (time.GetUtcNow(), releases);
            return releases;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException
                                              || (exception is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return null;
        }
    }

    /// <summary>
    /// Выпуски master — обычные v&lt;номер&gt;, выпуски dev — предварительные v&lt;номер&gt;-dev. Задачи —
    /// строки «- …» описания выпуска: их пишет сборка на GitHub.
    /// </summary>
    public static IReadOnlyList<PanelRelease> Parse(string json, string channel)
    {
        var tag = channel == PanelChannelStore.Dev ? DevTag() : MasterTag();
        using var document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateArray()
            .Where(release => !(release.TryGetProperty("draft", out var draft) && draft.GetBoolean()))
            .Select(release => (Tag: release.GetProperty("tag_name").GetString() ?? "", Release: release))
            .Select(release => (release.Tag, Match: tag.Match(release.Tag), release.Release))
            .Where(release => release.Match.Success)
            .Select(release => new PanelRelease(
                release.Match.Groups[1].Value,
                release.Tag,
                Tasks(release.Release.TryGetProperty("body", out var body) ? body.GetString() : null)))
            .OrderByDescending(release => PanelUpdates.Number(release.Version))
            .ToList();
    }

    private static List<string> Tasks(string? body) =>
        (body ?? "")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => line.StartsWith("- ", StringComparison.Ordinal))
            .Select(line => line[2..].Trim())
            .ToList();

    [GeneratedRegex(@"^v(\d+\.\d+\.\d+)$")]
    private static partial Regex MasterTag();

    [GeneratedRegex(@"^v(\d+\.\d+\.\d+)-dev$")]
    private static partial Regex DevTag();
}
