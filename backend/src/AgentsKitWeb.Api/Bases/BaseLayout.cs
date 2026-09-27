using System.Text.Json;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Bases;

/// <summary>
/// Где что лежит в базе кита на этом компьютере — раскладка кита формата 4 (base-layout.md кита,
/// адреса — как в его scripts/link-state.ps1). Общее знание — в корне базы; список копий этой машины
/// и имя её оператора — local\me.json вне git; личный репозиторий оператора local\me со своим git —
/// бэклог, память задач и их артефакты; папка оператора people\&lt;имя&gt; — его флоу и исполнители.
/// Базу другого формата панель не читает: кит сначала переводит её сам — решение оператора на B-275.
/// </summary>
public sealed partial record BaseLayout(string Base, string Operator, IReadOnlyList<string> Workspaces)
{
    /// <summary>Формат базы, который понимает панель, — поле version в agents-kit.json.</summary>
    public const int Format = 4;

    public const string MarkerFile = "agents-kit.json";

    /// <summary>Личный репозиторий оператора: бэклог, память задач и их артефакты, свой git.</summary>
    public string Personal => PersonalOf(Base);

    public static string PersonalOf(string basePath) => Path.Combine(basePath, "local", "me");

    /// <summary>Папка оператора этой машины в базе: его флоу и исполнители.</summary>
    public string OperatorDir => Path.Combine(Base, "people", Operator);

    /// <summary>Память задач всех машин оператора: work\&lt;машина&gt;\&lt;слаг копии&gt;.md.</summary>
    public string WorkDir => Path.Combine(Personal, "work");

    public const string BacklogName = "backlog.md";

    /// <summary>Бэклог оператора — в его личном репозитории.</summary>
    public string BacklogFile => Path.Combine(Personal, BacklogName);

    /// <summary>Память задач копий этой машины.</summary>
    public string MemoryDir => Path.Combine(WorkDir, Machine());

    /// <summary>Базой кита считается каталог с agents-kit.json — какого бы формата она ни была.</summary>
    public static bool IsBase(string path) => File.Exists(Path.Combine(path, MarkerFile));

    /// <summary>Раскладка базы этой машины; null — читать нечего, почему — problem.</summary>
    public static BaseLayout? Read(string basePath) => Read(basePath, out _);

    public static BaseLayout? Read(string basePath, out string problem)
    {
        switch (ReadFormat(basePath))
        {
            case null:
                problem = "Не прочитан agents-kit.json базы";
                return null;
            case < Format:
                problem = "База прежнего формата — переведите её китом";
                return null;
            case > Format:
                problem = "База нового формата, которого панель не знает, — обновите панель";
                return null;
        }

        var machine = ReadMachineFile(basePath);
        if (machine is null)
        {
            problem = @"Не прочитан local\me.json базы";
            return null;
        }
        if (machine.Operator is not { } name || !OperatorName().IsMatch(name))
        {
            problem = "На этом компьютере не назван оператор базы — возьмите проект под кит скиллом /onboard";
            return null;
        }

        var layout = new BaseLayout(basePath, name, machine.Workspaces);
        if (!Directory.Exists(Path.Combine(layout.Personal, ".git")))
        {
            problem = "На этом компьютере нет личного репозитория оператора — возьмите проект под кит скиллом /onboard";
            return null;
        }

        problem = "";
        return layout;
    }

    /// <summary>
    /// Имя этой машины, как его пишет кит в адрес памяти (Get-KitMachine): COMPUTERNAME первым —
    /// его наследует дочерний процесс, и стенд им подменяет машину.
    /// </summary>
    public static string Machine() =>
        Slug(Environment.GetEnvironmentVariable("COMPUTERNAME") is { Length: > 0 } name ? name : Environment.MachineName);

    /// <summary>Слаг кита (ConvertTo-KitSlug): нижний регистр, всё, кроме букв и цифр, — дефис, без дефисов по краям.</summary>
    public static string Slug(string text) => NotLetterOrDigit().Replace(text.ToLowerInvariant(), "-").Trim('-');

    /// <summary>Формат базы — целое version от 1 в agents-kit.json кита; null — файл не читается или не кита.</summary>
    private static int? ReadFormat(string basePath)
    {
        try
        {
            using var stream = File.OpenRead(Path.Combine(basePath, MarkerFile));
            using var json = JsonDocument.Parse(stream);
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("kit", out var kit) || kit.ValueKind != JsonValueKind.String || kit.GetString() != "agents-kit"
                || !root.TryGetProperty("version", out var version) || !version.TryGetInt32(out var format) || format < 1)
                return null;
            return format;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private sealed record MachineFile(string? Operator, IReadOnlyList<string> Workspaces);

    /// <summary>local\me.json: файла нет — пусто, как у кита; не разбирается — null.</summary>
    private static MachineFile? ReadMachineFile(string basePath)
    {
        var path = Path.Combine(basePath, "local", "me.json");
        if (!File.Exists(path))
            return new MachineFile(null, []);
        try
        {
            using var stream = File.OpenRead(path);
            using var json = JsonDocument.Parse(stream);
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;
            var name = root.TryGetProperty("operator", out var op) && op.ValueKind == JsonValueKind.String ? op.GetString() : null;
            var copies = root.TryGetProperty("workspaces", out var list) && list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray()
                    .Where(e => e.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(e.GetString()))
                    .Select(e => FullPath(e.GetString()!))
                    .ToList()
                : [];
            return new MachineFile(name, copies);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Путь копии, как его приводит кит (ConvertTo-KitPath).</summary>
    private static string FullPath(string path)
    {
        try
        {
            return WorkspaceCollector.Normalize(Path.GetFullPath(path));
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return WorkspaceCollector.Normalize(path);
        }
    }

    [GeneratedRegex(@"[^\p{L}\p{Nd}]+")]
    private static partial Regex NotLetterOrDigit();

    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex OperatorName();
}
