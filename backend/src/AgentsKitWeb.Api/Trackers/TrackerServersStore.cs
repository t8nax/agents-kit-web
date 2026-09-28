using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>Сервер трекера в «Настройках»: адрес и логин владельца ключа. Сам ключ наружу не отдаётся.</summary>
public sealed record TrackerServer(string Server, string Login);

/// <summary>
/// Серверы трекеров и ключи оператора к ним — trackers.json в профиле оператора, рядом с bases.json. Ключ лежит
/// зашифрованным под учётную запись Windows (DPAPI, CurrentUser): прочитать его может только этот пользователь
/// на этой машине, и в базы знаний он не попадает — решения оператора на B-288. Список общий для трекеров:
/// вид трекера у сервера не хранится, его называет описание трекера проекта.
/// </summary>
// DPAPI есть только в Windows — и панель работает только в ней: ставится задачей Планировщика заданий.
#pragma warning disable CA1416
public sealed class TrackerServersStore(string file)
{
    private readonly Lock _lock = new();

    // Ключ шифруется со своей добавкой: чужая программа того же пользователя, расшифровав его без неё, получит отказ.
    private static readonly byte[] Entropy = "agents-kit-web tracker key"u8.ToArray();

    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "trackers.json");

    /// <summary>Адрес для сравнения: схема и хост без регистра, без «/» в конце.</summary>
    public static string Normalize(string server)
    {
        var trimmed = server.Trim().TrimEnd('/');
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
            return trimmed;
        return $"{uri.Scheme}://{uri.Authority.ToLowerInvariant()}{uri.AbsolutePath.TrimEnd('/')}";
    }

    public static bool SameServer(string a, string b) =>
        string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase);

    public IReadOnlyList<TrackerServer> List()
    {
        lock (_lock)
            return [.. Read().Select(s => new TrackerServer(s.Server, s.Login))];
    }

    public bool Contains(string server)
    {
        lock (_lock)
            return Read().Any(s => SameServer(s.Server, server));
    }

    /// <summary>Ключ к серверу; null — сервера в списке нет или ключ не расшифровать.</summary>
    public string? KeyOf(string server)
    {
        lock (_lock)
        {
            var stored = Read().FirstOrDefault(s => SameServer(s.Server, server));
            if (stored is null)
                return null;
            try
            {
                return Encoding.UTF8.GetString(
                    ProtectedData.Unprotect(Convert.FromBase64String(stored.Key), Entropy, DataProtectionScope.CurrentUser));
            }
            catch (Exception e) when (e is CryptographicException or FormatException)
            {
                return null;
            }
        }
    }

    /// <summary>Сохраняет сервер с ключом: новый — в конец списка, известный — на своём месте с новым ключом.</summary>
    public void Save(string server, string login, string key)
    {
        var sealedKey = Convert.ToBase64String(
            ProtectedData.Protect(Encoding.UTF8.GetBytes(key), Entropy, DataProtectionScope.CurrentUser));
        lock (_lock)
        {
            var servers = Read();
            var index = servers.FindIndex(s => SameServer(s.Server, server));
            var stored = new StoredServer(index >= 0 ? servers[index].Server : server, login, sealedKey);
            if (index >= 0)
                servers[index] = stored;
            else
                servers.Add(stored);
            Write(servers);
        }
    }

    public bool Remove(string server)
    {
        lock (_lock)
        {
            var servers = Read();
            if (servers.RemoveAll(s => SameServer(s.Server, server)) == 0)
                return false;
            Write(servers);
            return true;
        }
    }

    private List<StoredServer> Read()
    {
        if (!File.Exists(file))
            return [];
        try
        {
            using var stream = File.OpenRead(file);
            return JsonSerializer.Deserialize<StoredFile>(stream, JsonOptions)?.Servers ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private void Write(List<StoredServer> servers)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new StoredFile(servers), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record StoredServer(string Server, string Login, string Key);

    private sealed record StoredFile(List<StoredServer> Servers);
}
