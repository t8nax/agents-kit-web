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
}
