using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Panel;

/// <summary>Версия, вышедшая в канале, и чем она была — заголовком слияния, которым пришла.</summary>
public sealed record PanelRelease(string Version, string Title);

/// <summary>
/// Что в канале есть сверх стоящей панели. Sha — код, на котором стоит канал: отстала панель или нет,
/// видно только по нему, потому что номер версии поднимает человек и пропускает. Latest — версия
/// канала; Releases — версии от стоящей до неё, новые первыми, и пустым он бывает у отставшей панели.
/// </summary>
public sealed record PanelUpdate(string Latest, string Sha, IReadOnlyList<PanelRelease> Releases);

/// <summary>
/// Вышедшие версии считаются по репозиторию проекта, который назвал published.json: номер версии
/// живёт в его version.txt, и меняют его слияния принятых задач.
/// </summary>
public static class PanelUpdates
{
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Больше полусотни слияний без обновления панели не разбираем: перечень всё равно не читают.</summary>
    private const int Limit = 50;

    public static async Task<PanelUpdate?> ReadAsync(
        string repository, string channel, string sha, string version, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(repository))
            return null;

        var fetched = await GitRunner.RunAsync(repository, FetchTimeout, cancellationToken, "fetch", "origin");
        if (fetched.ExitCode != 0)
            return null;

        if (await RevisionAsync(repository, $"origin/{channel}", cancellationToken) is not { } head)
            return null;

        if (await VersionAtAsync(repository, head, cancellationToken) is not { } latest)
            return null;

        return new PanelUpdate(latest, head, await ReleasesAsync(repository, channel, sha, version, cancellationToken));
    }

    private static async Task<IReadOnlyList<PanelRelease>> ReleasesAsync(
        string repository, string channel, string sha, string version, CancellationToken cancellationToken)
    {
        // --first-parent: по каналу идут слияния принятых задач, и заголовок слияния — это «что в версии».
        var log = await GitRunner.RunAsync(
            repository, ReadTimeout, cancellationToken,
            "log", "--first-parent", "-n", Limit.ToString(), "--format=%H%x1f%s", $"{sha}..origin/{channel}");
        // Панель стоит на коде, которого в этом репозитории нет, — сказать нечего, но Latest уже известен.
        if (log.ExitCode != 0)
            return [];

        var commits = log.Output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => line.Split(''))
            .Where(parts => parts.Length == 2)
            .Reverse()
            .ToList();

        var releases = new List<PanelRelease>();
        var previous = version;
        foreach (var commit in commits)
        {
            if (await VersionAtAsync(repository, commit[0], cancellationToken) is not { } at || at == previous)
                continue;
            releases.Add(new PanelRelease(at, commit[1]));
            previous = at;
        }
        releases.Reverse();
        return releases;
    }

    /// <summary>Код, на котором стоит ревизия: им панель и сравнивает себя с каналом.</summary>
    private static async Task<string?> RevisionAsync(string repository, string revision, CancellationToken cancellationToken)
    {
        var shown = await GitRunner.RunAsync(repository, ReadTimeout, cancellationToken, "rev-parse", $"{revision}^{{commit}}");
        if (shown.ExitCode != 0)
            return null;
        var sha = shown.Output.Trim();
        return sha.Length == 0 ? null : sha;
    }

    private static async Task<string?> VersionAtAsync(string repository, string revision, CancellationToken cancellationToken)
    {
        var shown = await GitRunner.RunAsync(repository, ReadTimeout, cancellationToken, "show", $"{revision}:version.txt");
        if (shown.ExitCode != 0)
            return null;
        var version = shown.Output.Trim();
        return version.Length == 0 ? null : version;
    }
}
