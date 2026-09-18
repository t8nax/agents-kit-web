using System.Text.Json;

namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Канал, из которого панель собирает себя: master — принятое и слитое, dev — свежее.
/// Лежит в panel.json профиля оператора, рядом с bases.json: выбор его, а не проекта,
/// и переживает подмену каталога панели.
/// </summary>
public sealed class PanelChannelStore(string file)
{
    public const string Master = "master";
    public const string Dev = "dev";

    private readonly Lock _lock = new();

    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "panel.json");

    public static bool Known(string? channel) => channel is Master or Dev;

    /// <summary>Выбора ещё не было — null: канал тогда берут у поставленной панели.</summary>
    public string? Read()
    {
        lock (_lock)
        {
            try
            {
                if (!File.Exists(file))
                    return null;
                var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(file));
                return Known(stored?.Channel) ? stored!.Channel : null;
            }
            catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }
    }

    public void Write(string channel)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
            File.WriteAllText(file, JsonSerializer.Serialize(new Stored(channel)));
        }
    }

    private sealed record Stored(string? Channel);
}
