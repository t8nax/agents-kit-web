using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Трекер проекта, как его назвал tracker.md корня базы. Kind — «github» (Repo — «владелец/репозиторий»),
/// «no-address» (трекер GitHub, но адреса репозитория нет), «not-github» или «unreadable» (файл не прочитан).
/// </summary>
public sealed record TrackerInfo(string Kind, string? Repo = null)
{
    public const string GitHub = "github";
    public const string NoAddress = "no-address";
    public const string NotGitHub = "not-github";
    public const string Unreadable = "unreadable";
}

/// <summary>
/// tracker.md кита — описание трекера словами, строгого формата у него нет. Задачи панель читает только
/// у GitHub и только из репозитория, чей адрес github.com/&lt;владелец&gt;/&lt;репозиторий&gt; назван в разделе
/// «## Где задачи», — решения оператора на B-277; репозиторий кода проекта вместо него не подставляется.
/// Раздел — как у сверки кита (Get-KitTrackerFindings): заголовок «##» вне блока кода до следующего такого же,
/// HTML-комментарии вырезаны.
/// </summary>
public static partial class Tracker
{
    private const string WhereSection = "Где задачи";

    // Адрес GitHub, в котором вместо владельца — раздел сайта, репозитория не называет: доска проекта
    // организации, профиль, настройки.
    private static readonly HashSet<string> NotOwners = new(StringComparer.OrdinalIgnoreCase)
    {
        "orgs", "users", "enterprises", "settings", "apps", "marketplace", "sponsors", "topics", "features",
    };

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
        var where = Section(Comment().Replace(text, ""), WhereSection);
        foreach (Match match in RepoAddress().Matches(where))
        {
            var owner = match.Groups["owner"].Value;
            if (NotOwners.Contains(owner))
                continue;
            var repo = match.Groups["repo"].Value.TrimEnd('.');
            if (repo.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
                repo = repo[..^4];
            if (repo.Length > 0)
                return new TrackerInfo(TrackerInfo.GitHub, $"{owner}/{repo}");
        }
        return where.Contains("github", StringComparison.OrdinalIgnoreCase)
            ? new TrackerInfo(TrackerInfo.NoAddress)
            : new TrackerInfo(TrackerInfo.NotGitHub);
    }

    private static string Section(string text, string name)
    {
        var lines = new List<string>();
        var inside = false;
        var fence = false;
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            if (line.StartsWith("```", StringComparison.Ordinal))
                fence = !fence;
            if (!fence && Heading().Match(line) is { Success: true } heading)
            {
                inside = heading.Groups[1].Value == name;
                continue;
            }
            if (inside)
                lines.Add(line);
        }
        return string.Join('\n', lines);
    }

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment();

    [GeneratedRegex(@"^##\s+(.+?)\s*$")]
    private static partial Regex Heading();

    [GeneratedRegex(@"github\.com[/:](?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?<repo>[A-Za-z0-9._-]+)", RegexOptions.IgnoreCase)]
    private static partial Regex RepoAddress();
}
