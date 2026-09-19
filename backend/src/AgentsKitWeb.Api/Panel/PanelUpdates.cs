using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Panel;

/// <summary>Законченная задача, уехавшая в канал: заголовок, которым она туда пришла.</summary>
public sealed record PanelRelease(string Sha, string Title);

/// <summary>
/// Что в канале есть сверх стоящей панели. Sha — код, на котором стоит канал: отстала панель или нет,
/// видно только по нему, потому что номер версии поднимает человек и пропускает его. Releases — задачи
/// от стоящей панели до вершины канала, новые первыми.
/// </summary>
public sealed record PanelUpdate(string Sha, IReadOnlyList<PanelRelease> Releases);

/// <summary>
/// Что приедет с обновлением, считается по репозиторию проекта, который назвал published.json:
/// задачи, приехавшие в канал после того, как панель собрали.
/// </summary>
public static class PanelUpdates
{
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Больше полусотни задач без обновления панели не разбираем: перечень всё равно не читают.</summary>
    private const int Limit = 50;

    private const char Separator = '\u001f';

    private sealed record Commit(string Sha, string[] Parents, string Title);

    public static async Task<PanelUpdate?> ReadAsync(
        string repository, string channel, string sha, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(repository))
            return null;

        var fetched = await GitRunner.RunAsync(repository, FetchTimeout, cancellationToken, "fetch", "origin");
        if (fetched.ExitCode != 0)
            return null;

        if (await RevisionAsync(repository, $"origin/{channel}", cancellationToken) is not { } head)
            return null;

        return new PanelUpdate(head, await ReleasesAsync(repository, sha, head, cancellationToken));
    }

    private static async Task<IReadOnlyList<PanelRelease>> ReleasesAsync(
        string repository, string sha, string head, CancellationToken cancellationToken)
    {
        var arrived = new List<PanelRelease>();
        // Панель стоит на коде, которого в этом репозитории нет, — назвать нечего, но отставание уже видно.
        foreach (var commit in await FirstParentAsync(repository, $"{sha}..{head}", cancellationToken))
        {
            if (!Mechanical(commit.Title))
            {
                arrived.Add(new PanelRelease(commit.Sha, Arrived(commit.Title)));
                continue;
            }

            // Пачка: в master одним слиянием приезжает всё, что накопилось в dev, а задачи лежат внутри
            // неё. Разворачиваем пачку в то, что она привезла, иначе перечень — череда одинаковых строк.
            if (commit.Parents.Length < 2)
                continue;
            var inside = await FirstParentAsync(
                repository, $"{commit.Parents[0]}..{commit.Parents[1]}", cancellationToken);
            arrived.AddRange(inside
                .Where(task => !Mechanical(task.Title))
                .Select(task => new PanelRelease(task.Sha, Arrived(task.Title))));
        }

        return arrived.Take(Limit).ToList();
    }

    /// <summary>
    /// Череда первых родителей: так в канал и приезжает работа. Слияние, которым задача подтянула
    /// канал к себе перед мержем, лежит в стороне от этой череды и в перечень не попадает.
    /// </summary>
    private static async Task<IReadOnlyList<Commit>> FirstParentAsync(
        string repository, string range, CancellationToken cancellationToken)
    {
        var log = await GitRunner.RunAsync(
            repository, ReadTimeout, cancellationToken,
            "log", "--first-parent", "-n", Limit.ToString(), $"--format=%H{Separator}%P{Separator}%s", range);
        if (log.ExitCode != 0)
            return [];

        return log.Output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => line.Split(Separator))
            .Where(parts => parts.Length == 3)
            .Select(parts => new Commit(
                parts[0], parts[1].Split(' ', StringSplitOptions.RemoveEmptyEntries), parts[2]))
            .ToList();
    }

    /// <summary>
    /// Слияние, чей заголовок git написал сам, — «Merge dev into master», «Merge branch …»: оператору
    /// оно не говорит ничего, и в перечне вместо него стоят задачи, которые оно привезло.
    /// </summary>
    private static bool Mechanical(string title) =>
        title.StartsWith("Merge branch ", StringComparison.Ordinal)
        || title.StartsWith("Merge remote-tracking branch ", StringComparison.Ordinal)
        || (title.StartsWith("Merge ", StringComparison.Ordinal)
            && title.Contains(" into ", StringComparison.Ordinal)
            && !title.Contains(": ", StringComparison.Ordinal));

    /// <summary>
    /// «Merge fix/some-task: что сделано» — приставка слияния оператору не говорит ничего, и в карточке
    /// остаётся только сама фраза о правке.
    /// </summary>
    private static string Arrived(string title)
    {
        if (!title.StartsWith("Merge ", StringComparison.Ordinal))
            return title;
        var colon = title.IndexOf(": ", StringComparison.Ordinal);
        // Имя ветки — одно слово; пробел в нём значит, что это не приставка, а обычный заголовок.
        return colon > 0 && !title[6..colon].Contains(' ') ? title[(colon + 2)..] : title;
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
}
