using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Что постановка записала рядом с exe поставленной панели: из какого канала она собрана, каким кодом
/// и в каком репозитории GitHub (owner/repo) лежат выпуски, которыми она обновляется. Releases нет
/// у сборки, поставленной до выпусков на GitHub.
/// </summary>
public sealed record PublishedPanel(
    string Channel,
    string Ref,
    string Sha,
    string Version,
    DateTimeOffset BuiltAt,
    string? Releases,
    string Target,
    int Port,
    string TaskName);

/// <summary>
/// Поставленная панель против запуска для разработки. Признак один — файл публикации рядом с exe:
/// его кладёт deploy.ps1, и больше его положить некому.
/// </summary>
public sealed class InstalledPanel(string file)
{
    private static readonly JsonSerializerOptions Format = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string DefaultFile => Path.Combine(AppContext.BaseDirectory, "published.json");

    public string File { get; } = file;

    /// <summary>Номер версии этой сборки — из version.txt репозитория, зашитый в неё при сборке.</summary>
    public static string Version
    {
        get
        {
            var informational = Assembly.GetEntryAssembly()
                ?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion;
            // Сборка дописывает к номеру «+<sha>», когда репозиторий под рукой; оператору он не нужен.
            var version = informational?.Split('+')[0];
            return string.IsNullOrWhiteSpace(version) ? "0.0.0" : version;
        }
    }

    /// <summary>Файла нет или он испорчен — панель запущена для разработки, а не поставлена.</summary>
    public PublishedPanel? Read()
    {
        try
        {
            if (!System.IO.File.Exists(File))
                return null;
            return JsonSerializer.Deserialize<PublishedPanel>(System.IO.File.ReadAllText(File), Format);
        }
        catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
