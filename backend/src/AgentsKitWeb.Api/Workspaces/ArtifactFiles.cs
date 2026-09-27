using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Файл, который оператор приложил в окне: имя, как его назвал браузер, и содержимое в base64.</summary>
public sealed record AttachedFile(string Name, string Data);

/// <summary>Приложенный файл не лёг в базу: Problem — too-large (крупнее потолка) или unreadable (не base64).</summary>
public sealed record AttachRejected(string Name, string Problem);

/// <summary>Файлы артефактов в базе — по раскладке кита: плоский каталог artifacts/ в корне базы.</summary>
public static partial class ArtifactFiles
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

    // В имени файла остаются буквы, цифры, точка, дефис и подчёркивание: пробел, скобки, кавычки и знаки cmd
    // оборвали бы ссылку при сверке кита или не прошли бы в запуск VS Code.
    [GeneratedRegex(@"[^\p{L}\p{N}._-]+")]
    private static partial Regex Unsafe { get; }

    /// <summary>
    /// Кладёт приложенные файлы копиями в artifacts/ базы и отдаёт их адреса artifacts/&lt;имя&gt; по порядку. Имя —
    /// как у файла, с номером задачи или записи спереди, если он известен; занятое — с числом, чужой файл не
    /// перезаписывается. Сначала проверяются все файлы: не прошёл один — не ложится ни один. В git не кладёт.
    /// </summary>
    public static async Task<(IReadOnlyList<string>? Addresses, AttachRejected? Rejected)> SaveAsync(
        string basePath, IReadOnlyList<AttachedFile> files, string? number, CancellationToken cancellationToken)
    {
        var (decoded, rejected) = Decode(files);
        if (rejected is not null)
            return (null, rejected);

        var folder = Path.Combine(basePath, Folder);
        Directory.CreateDirectory(folder);
        var addresses = new List<string>();
        try
        {
            foreach (var (name, bytes) in decoded)
            {
                var path = FreePath(folder, FileName(name, number));
                // CreateNew: файл, заведённый соседней сессией между проверкой имени и записью, не перезапишется.
                await using (var stream = new FileStream(path, FileMode.CreateNew))
                {
                    addresses.Add($"{Folder}/{Path.GetFileName(path)}");
                    await stream.WriteAsync(bytes, cancellationToken);
                }
            }
        }
        catch
        {
            // Лёг не весь набор — не остаётся ни одного: файл без ссылки сверка кита назвала бы.
            Delete(basePath, addresses);
            throw;
        }
        return (addresses, null);
    }

    /// <summary>Убирает файлы по адресам artifacts/; не удалившийся остаётся, и его назовёт сверка кита.</summary>
    public static void Delete(string basePath, IEnumerable<string> addresses)
    {
        foreach (var address in addresses)
        {
            try
            {
                File.Delete(Path.Combine(basePath, address));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    // Ссылка — как её разбирает сверка кита (base-check.ps1, Get-KitArtifactRefs): путь artifacts/<имя>, перед
    // которым не часть другого пути; имя — знаки до пробела, кавычки, скобки или разделителя, а точка и двоеточие
    // на конце — знак препинания, а не имя. HTML-комментарий ссылкой не считается.
    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment { get; }

    [GeneratedRegex(@"(?<![\w./\\-])(?:\.\./)*artifacts/([^\s`'""()<>\[\]|,;*/\\]+)")]
    private static partial Regex Reference { get; }

    /// <summary>Текст .md ссылается на файл artifacts/ — так, как ссылку считает сверка кита.</summary>
    public static bool Mentions(string text, string address)
    {
        var name = address[(address.IndexOf('/') + 1)..];
        return Reference.Matches(Comment.Replace(text, ""))
            .Any(m => m.Groups[1].Value.TrimEnd('.', ':').Equals(name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Приложенное, которое в базу не ляжет: крупнее потолка или не base64. null — ложится всё.</summary>
    public static AttachRejected? Check(IReadOnlyList<AttachedFile> files) => Decode(files).Rejected;

    /// <summary>Слова отказа для оператора.</summary>
    public static string Refusal(AttachRejected rejected) => rejected.Problem == "too-large"
        ? $"Файл не приложен: {rejected.Name} крупнее {MaxBytes / 1024 / 1024} МБ"
        : $"Файл не приложен: {rejected.Name} не прочитан";

    private static (List<(string Name, byte[] Bytes)> Decoded, AttachRejected? Rejected) Decode(IReadOnlyList<AttachedFile> files)
    {
        var decoded = new List<(string Name, byte[] Bytes)>();
        foreach (var file in files)
        {
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(file.Data);
            }
            catch (FormatException)
            {
                return (decoded, new AttachRejected(file.Name, "unreadable"));
            }
            if (bytes.Length > MaxBytes)
                return (decoded, new AttachRejected(file.Name, "too-large"));
            decoded.Add((file.Name, bytes));
        }
        return (decoded, null);
    }

    /// <summary>Имя файла в artifacts/: безопасные знаки, номер спереди, если его ещё нет в имени.</summary>
    public static string FileName(string name, string? number)
    {
        var file = Path.GetFileName(name.Replace('\\', '/'));
        var stem = Unsafe.Replace(Path.GetFileNameWithoutExtension(file), "-").Trim('-', '.');
        var extension = Unsafe.Replace(Path.GetExtension(file), "");
        var own = (stem.Length == 0 ? "файл" : stem) + (extension.Length > 1 ? extension : "");
        return number is null || own.StartsWith(number + "-", StringComparison.OrdinalIgnoreCase) ? own : $"{number}-{own}";
    }

    private static string FreePath(string folder, string name)
    {
        var path = Path.Combine(folder, name);
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        for (var i = 2; File.Exists(path) || Directory.Exists(path); i++)
            path = Path.Combine(folder, $"{stem}-{i}{extension}");
        return path;
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
            .Where(name => !texts.Any(text => Mentions(text, $"{Folder}/{name}")))
            .Select(name => $"{Folder}/{name}")
            .ToList();
    }
}
