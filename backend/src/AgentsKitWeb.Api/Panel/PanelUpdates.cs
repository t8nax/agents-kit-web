using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Panel;

/// <summary>Законченная задача, уехавшая в канал: заголовок слияния, которым она туда пришла.</summary>
public sealed record PanelRelease(string Sha, string Title);

/// <summary>
/// Что в канале есть сверх стоящей панели. Sha — код, на котором стоит канал: отстала панель или нет,
/// видно только по нему, потому что номер версии поднимает человек и пропускает его. Releases — задачи
/// от стоящей панели до вершины канала, новые первыми.
/// </summary>
public sealed record PanelUpdate(string Sha, IReadOnlyList<PanelRelease> Releases);

/// <summary>
/// Что приедет с обновлением, считается по репозиторию проекта, который назвал published.json:
/// слияния канала от кода стоящей панели до его вершины.
/// </summary>
public static class PanelUpdates
{
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Больше полусотни слияний без обновления панели не разбираем: перечень всё равно не читают.</summary>
    private const int Limit = 50;

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
        // --first-parent: по каналу идут слияния принятых задач, и заголовок слияния — это «что приедет».
        var log = await GitRunner.RunAsync(
            repository, ReadTimeout, cancellationToken,
            "log", "--first-parent", "-n", Limit.ToString(), "--format=%H%x1f%s", $"{sha}..{head}");
        // Панель стоит на коде, которого в этом репозитории нет, — назвать нечего, но отставание уже видно.
        if (log.ExitCode != 0)
            return [];

        return log.Output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => line.Split('\u001f'))
            .Where(parts => parts.Length == 2)
            .Select(parts => new PanelRelease(parts[0], Arrived(parts[1])))
            .ToList();
    }

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
