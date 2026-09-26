namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Файлы артефактов в базе — по раскладке кита: плоский каталог artifacts/ в корне базы.</summary>
public static class ArtifactFiles
{
    public const string Folder = "artifacts";

    /// <summary>Потолок артефакта по раскладке кита: крупнее в базу не кладётся.</summary>
    public const long MaxBytes = 5 * 1024 * 1024;

    /// <summary>Ссылка на файл в artifacts/ базы — путь от её корня, как его пишет кит.</summary>
    public static bool InBase(string address) =>
        address.StartsWith(Folder + "/", StringComparison.OrdinalIgnoreCase)
        || address.StartsWith(Folder + "\\", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Полный путь файла artifacts/ базы или null, если адрес выводит из каталога: каталог плоский,
    /// и ссылка вида artifacts/../product.md файлом-артефактом не считается.
    /// </summary>
    public static string? PathIn(string basePath, string address)
    {
        if (!InBase(address))
            return null;

        var folder = Path.GetFullPath(Path.Combine(basePath, Folder));
        var path = Path.GetFullPath(Path.Combine(basePath, address));
        return string.Equals(Path.GetDirectoryName(path), folder, StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    /// <summary>
    /// Файлы artifacts/ из названных адресов, на которые после правки не ссылается ни один .md базы: по раскладке
    /// кита файл живёт, пока на него есть ссылка, и уходит тем же коммитом, что убрал последнюю. Правленый файл
    /// читается из changed (путь от корня базы → новый текст), остальные — с диска; local/ и .git/ не в счёт.
    /// Возвращает пути от корня базы через «/», как их коммитит git.
    /// </summary>
    public static IReadOnlyList<string> Orphans(
        string basePath, IEnumerable<string> addresses, IReadOnlyDictionary<string, string> changed)
    {
        var names = addresses
            .Select(a => PathIn(basePath, a))
            .OfType<string>()
            .Select(Path.GetFileName)
            .OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(name => File.Exists(Path.Combine(basePath, Folder, name)))
            .ToList();
        if (names.Count == 0)
            return [];

        var texts = new List<string>(changed.Values);
        foreach (var file in Directory.EnumerateFiles(basePath, "*.md", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(basePath, file).Replace('\\', '/');
            if (relative.StartsWith(".git/") || relative.StartsWith("local/") || changed.ContainsKey(relative))
                continue;
            try
            {
                texts.Add(File.ReadAllText(file));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Непрочитанный файл мог ссылаться на артефакт: удалять по нему нельзя.
                return [];
            }
        }

        return names
            .Where(name => !texts.Any(text => text.Contains($"{Folder}/{name}", StringComparison.OrdinalIgnoreCase)))
            .Select(name => $"{Folder}/{name}")
            .ToList();
    }
}
