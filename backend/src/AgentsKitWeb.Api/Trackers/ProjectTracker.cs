using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>
/// Чем кончилась проверка описания трекера перед записью. Checked — false: трекер панель не читает (Jira, GitLab),
/// и описание пишется без проверки. Problem задан — задачи не прочитаны: значения — как у TrackerIssues.
/// </summary>
public sealed record TrackerCheck(bool Checked, string? Field = null, string? Problem = null, string? Detail = null)
{
    public bool Passed => Problem is null;
}

/// <summary>
/// Трекер проекта, как его называет описание трекера базы: GitHub панель читает программой gh оператора (B-277),
/// YouTrack — своим клиентом с ключом из «Настроек» (B-288). Другие трекеры панель не читает.
/// </summary>
public sealed partial class ProjectTracker(IGitHubIssues github, IYouTrack youTrack, TrackerServersStore servers)
{
    /// <summary>Незакрытые задачи трекера базы, назначенные на оператора; не прочитали — Problem.</summary>
    public Task<TrackerIssues> AssignedAsync(BaseLayout layout, CancellationToken cancellationToken) =>
        AssignedAsync(Tracker.Read(layout), cancellationToken);

    /// <summary>
    /// Проверка описания перед записью — решение оператора на B-293: у GitHub и YouTrack панель читает задачи,
    /// назначенные на оператора, из названных трекера и проекта — тем же разбором, которым прочтёт записанный файл;
    /// у Jira и GitLab проверить нечем, и Checked — false. Не прочитала — Problem, как у задач «Бэклога», и Field —
    /// поле окна, к которому причина относится: server или project; причина вне полей (нет gh) — null.
    /// </summary>
    public async Task<TrackerCheck> CheckAsync(TrackerDescription description, CancellationToken cancellationToken)
    {
        var tracker = Tracker.Parse(TrackerDescriptions.Serialize(description, "Проверка"));
        if (tracker.Kind is not (TrackerInfo.GitHub or TrackerInfo.YouTrack))
            return new TrackerCheck(false);

        var issues = await AssignedAsync(tracker, cancellationToken);
        return issues.Problem switch
        {
            null => new TrackerCheck(true),
            TrackerIssues.RepoUnreachable or TrackerIssues.ProjectMissing =>
                new TrackerCheck(true, "project", issues.Problem, issues.Detail),
            TrackerIssues.GhMissing or TrackerIssues.GhLogin =>
                new TrackerCheck(true, null, issues.Problem, issues.Detail),
            _ => new TrackerCheck(true, "server", issues.Problem, issues.Detail),
        };
    }

    private async Task<TrackerIssues> AssignedAsync(TrackerInfo? tracker, CancellationToken cancellationToken) =>
        tracker switch
        {
            null => new TrackerIssues([], TrackerIssues.NoTracker),
            { GitHubRepo: { } repo } => await github.AssignedAsync(repo, cancellationToken),
            { Kind: TrackerInfo.YouTrack, Server: { } server, Project: { } project } =>
                KeyOf(server, out var problem) is { } key
                    ? await youTrack.AssignedAsync(server, key, project, cancellationToken)
                    : new TrackerIssues([], problem),
            var other => new TrackerIssues([], other.Kind),
        };

    /// <summary>
    /// Ключ сервера YouTrack. Нет его — почему: сервера нет в «Настройках» (no-key) или ключ не прочитать —
    /// не расшифровался на этом компьютере или файл серверов битый (key-unreadable, совет — «Заменить ключ»).
    /// </summary>
    private string? KeyOf(string server, out string? problem)
    {
        try
        {
            var (known, key) = servers.Find(server);
            problem = key is not null ? null : known ? TrackerIssues.KeyUnreadable : TrackerIssues.NoKey;
            return key;
        }
        catch (TrackersFileBroken)
        {
            problem = TrackerIssues.KeyUnreadable;
            return null;
        }
    }

    /// <summary>Почему записи бэклога проекта переносить некуда — продолжением фразы.</summary>
    public const string NotMovable = "трекер проекта — не GitHub и не YouTrack со строками «трекер:», «сервер:», «проект:»";

    /// <summary>Трекер, в который запись бэклога переносится: GitHub или YouTrack; иначе null.</summary>
    public static TrackerInfo? Movable(BaseLayout layout) =>
        Tracker.Read(layout) is { Kind: TrackerInfo.GitHub or TrackerInfo.YouTrack } tracker ? tracker : null;

    /// <summary>Новая задача трекера на оператора — перенос записи бэклога (B-286, B-288).</summary>
    public async Task<CreatedIssue> CreateAsync(TrackerInfo tracker, string title, string body) =>
        tracker switch
        {
            { GitHubRepo: { } repo } => await github.CreateAsync(repo, title, body),
            { Kind: TrackerInfo.YouTrack, Server: { } server, Project: { } project } =>
                KeyOf(server, out var problem) is { } key
                    ? await youTrack.CreateAsync(server, key, project, title, body)
                    : new CreatedIssue(null, problem),
            _ => new CreatedIssue(null, tracker.Kind),
        };

    /// <summary>
    /// Имя задачи трекера, как его пишет кит: «GitHub #37», «YouTrack ABC-12». Регистр и пробел перед «#» ничего
    /// не значат, у YouTrack буквы номера — прописными (backlog-record.md кита, «Номер»). Не имя задачи — null.
    /// </summary>
    public static string? IssueName(string text)
    {
        var match = IssueNamePattern().Match(text.Trim());
        return match.Success ? Canonical(match) : null;
    }

    /// <summary>Имя задачи трекера, которым начат заголовок задачи в строке копии: «YouTrack ABC-12 Заголовок».</summary>
    public static string? IssueNameAtStart(string task)
    {
        var match = IssueTitlePattern().Match(task);
        return match.Success ? Canonical(match) : null;
    }

    private static string? Canonical(Match match) =>
        match.Groups["github"].Success && int.TryParse(match.Groups["github"].Value, out var number) && number > 0
            ? $"GitHub #{number}"
            : match.Groups["youtrack"].Success ? $"YouTrack {match.Groups["youtrack"].Value.ToUpperInvariant()}"
            : null;

    [GeneratedRegex(@"^(?:github\s*#(?<github>\d{1,9})|youtrack\s+(?<youtrack>[A-Za-z][A-Za-z0-9_]*-\d{1,9}))$", RegexOptions.IgnoreCase)]
    private static partial Regex IssueNamePattern();

    [GeneratedRegex(@"^\s*(?:github\s*#(?<github>\d{1,9})|youtrack\s+(?<youtrack>[A-Za-z][A-Za-z0-9_]*-\d{1,9}))(?:\s|$)", RegexOptions.IgnoreCase)]
    private static partial Regex IssueTitlePattern();
}
