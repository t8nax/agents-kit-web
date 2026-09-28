using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Трекер проекта по строкам «трекер:», «сервер:», «проект:» раздела «## Где задачи» tracker.md корня базы.
/// Kind — «github» или «youtrack» (Server и Project названы), «other» — трекер, которого панель не читает
/// (Name — как его назвал файл), «no-keys» — строк нет, какая-то пуста, повторена или не того вида,
/// «unreadable» — файл не прочитан.
/// </summary>
public sealed record TrackerInfo(string Kind, string? Name = null, string? Server = null, string? Project = null)
{
    public const string GitHub = "github";
    public const string YouTrack = "youtrack";
    public const string Other = "other";
    public const string NoKeys = "no-keys";
    public const string Unreadable = "unreadable";

    /// <summary>
    /// Репозиторий для gh: «владелец/репозиторий» на github.com, «хост/владелец/репозиторий» на GitHub Enterprise.
    /// </summary>
    [JsonIgnore]
    public string? GitHubRepo =>
        Kind != GitHub || Server is null || Project is null ? null
        : new Uri(Server).Host is var host && host.Equals("github.com", StringComparison.OrdinalIgnoreCase) ? Project
        : $"{host}/{Project}";
}

/// <summary>
/// tracker.md кита формата 7: раздел «## Где задачи» начинается строками «ключ: значение» до первой пустой
/// строки или прозы — трекер, сервер и проект, каждый по разу; проект — по шаблону своего трекера из таблицы
/// трекеров раскладки кита, сервер — http(s)://хост[:порт][/путь] без логина, пароля, запроса и фрагмента.
/// Разбор — как у сверки кита (Get-KitTrackerKeys в base-check.ps1): заголовок «##» вне блока кода,
/// HTML-комментарии вырезаны. В прозе раздела панель ничего не ищет — ни у YouTrack, ни у GitHub: решение
/// оператора на B-288, трекер без строк не читается, пока их не допишут скиллом /tracker.
/// </summary>
public static partial class Tracker
{
    private const string WhereSection = "Где задачи";

    /// <summary>Трекер базы; tracker.md нет — у проекта нет трекера, null.</summary>
    public static TrackerInfo? Read(BaseLayout layout)
    {
        var file = layout.TrackerFile;
        if (!File.Exists(file))
            return null;
        try
        {
            return Parse(File.ReadAllText(file));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new TrackerInfo(TrackerInfo.Unreadable);
        }
    }

    public static TrackerInfo Parse(string text)
    {
        var keys = Keys(Comment().Replace(text, ""));
        string? Single(string key) =>
            keys.Where(k => k.Key == key).ToList() is [var only] && only.Value.Length > 0 ? only.Value : null;

        var name = Single("трекер");
        var server = Single("сервер");
        var project = Single("проект");
        if (name is null || server is null || project is null || !ServerAddress().IsMatch(server))
            return new TrackerInfo(TrackerInfo.NoKeys);

        server = server.TrimEnd('/');
        return name.ToLowerInvariant() switch
        {
            "github" => GitHubProject().IsMatch(project)
                ? new TrackerInfo(TrackerInfo.GitHub, "GitHub", server, project)
                : new TrackerInfo(TrackerInfo.NoKeys),
            "youtrack" => YouTrackProject().IsMatch(project)
                ? new TrackerInfo(TrackerInfo.YouTrack, "YouTrack", server, project)
                : new TrackerInfo(TrackerInfo.NoKeys),
            _ => new TrackerInfo(TrackerInfo.Other, name),
        };
    }

    /// <summary>Адрес сервера того вида, что принимает кит в строке «сервер:».</summary>
    public static bool IsServerAddress(string server) => ServerAddress().IsMatch(server);

    private static List<KeyValuePair<string, string>> Keys(string text)
    {
        var keys = new List<KeyValuePair<string, string>>();
        var inside = false;
        var fence = false;
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            if (line.StartsWith("```", StringComparison.Ordinal))
                fence = !fence;
            if (!fence && Heading().Match(line) is { Success: true } heading)
            {
                if (inside)
                    break;
                inside = heading.Groups[1].Value == WhereSection;
                continue;
            }
            if (!inside)
                continue;
            if (line.Trim().Length == 0)
            {
                if (keys.Count > 0)
                    break;
                continue;
            }
            if (Pair().Match(line) is not { Success: true } pair)
                break;
            keys.Add(new(pair.Groups[1].Value.ToLowerInvariant(), pair.Groups[2].Value));
        }
        return keys;
    }

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment();

    [GeneratedRegex(@"^##\s+(.+?)\s*$")]
    private static partial Regex Heading();

    [GeneratedRegex(@"^\s*([^\s:][^:]*?)\s*:\s*(.*?)\s*$")]
    private static partial Regex Pair();

    // Логин, пароль, запрос и фрагмент — «@», «?», «#» — адрес не несёт: секрету не место в базе.
    [GeneratedRegex(@"^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[^\s@?#]*)?$")]
    private static partial Regex ServerAddress();

    [GeneratedRegex(@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
    private static partial Regex GitHubProject();

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_]*$")]
    private static partial Regex YouTrackProject();
}
