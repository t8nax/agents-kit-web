using System.Text.Json;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Bases;

/// <summary>
/// Где что лежит в базе кита на этом компьютере — раскладка кита формата 8 (base-layout.md кита,
/// адреса — как в его scripts/link-state.ps1). Общее знание — в корне базы; список копий этой машины
/// и имя её оператора — local\me.json вне git; личный репозиторий оператора local\me со своим git —
/// его рамки, флоу, исполнители, бэклог, память задач и их артефакты. Папка оператора people\&lt;имя&gt;
/// держит только выложенное для коллег, и панель её не читает: агент оператора по ней не работает.
/// Базу прежнего формата панель не читает: кит сначала переводит её сам — решение оператора на B-275. Базу нового
/// формата читает по своей раскладке с пометкой NewerFormat: выпуска под новый формат ещё нет, а без базы в панели
/// не взять и задачу на него — решение оператора на B-281.
/// </summary>
public sealed partial record BaseLayout(string Base, string Operator, IReadOnlyList<string> Workspaces)
{
    /// <summary>Формат базы, который понимает панель, — поле version в agents-kit.json.</summary>
    public const int Format = 8;

    /// <summary>
    /// База новее формата панели: читается, но панель в неё не пишет — ни флоу, ни исполнителей, ни бэклог;
    /// ответ агенту, запуск задачи и копии открыты — решение оператора на B-281.
    /// </summary>
    public bool NewerFormat { get; init; }

    /// <summary>Предупреждение о базе нового формата — одно на все разделы панели.</summary>
    public const string NewerFormatWarning =
        "Кит перевёл базу на формат, которого эта версия панели не знает. Часть данных может показываться неверно, " +
        "правка флоу, исполнителей и бэклога закрыта. Обновите панель, когда выйдет выпуск под новый формат.";

    /// <summary>Причина отказа записи в базу нового формата — её же называют погашенные кнопки панели.</summary>
    public const string NewerFormatRefusal =
        "Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.";

    /// <summary>Предупреждение о формате базы для ответа API; null — база формата панели.</summary>
    public string? FormatWarning => NewerFormat ? NewerFormatWarning : null;

    public const string MarkerFile = "agents-kit.json";

    /// <summary>
    /// Личный репозиторий оператора, свой git: рамки, флоу (flow/), исполнители (agents/), бэклог, память задач
    /// и их артефакты.
    /// </summary>
    public string Personal => PersonalOf(Base);

    public static string PersonalOf(string basePath) => Path.Combine(basePath, "local", "me");

    /// <summary>Память задач всех машин оператора: work\&lt;машина&gt;\&lt;слаг копии&gt;.md.</summary>
    public string WorkDir => Path.Combine(Personal, "work");

    public const string BacklogName = "backlog.md";

    /// <summary>Бэклог оператора — в его личном репозитории.</summary>
    public string BacklogFile => Path.Combine(Personal, BacklogName);

    public const string TrackerName = "tracker.md";

    /// <summary>Описание трекера проекта — общее знание, в корне базы; файла нет — трекера у проекта нет.</summary>
    public string TrackerFile => Path.Combine(Base, TrackerName);

    /// <summary>Память задач копий этой машины.</summary>
    public string MemoryDir => Path.Combine(WorkDir, Machine());

    /// <summary>Базой кита считается каталог с agents-kit.json — какого бы формата она ни была.</summary>
    public static bool IsBase(string path) => File.Exists(Path.Combine(path, MarkerFile));

    /// <summary>
    /// Причина, по которой панель не читает базу прежнего формата: перевести её можно кнопкой в «Проблемах баз» (B-314).
    /// </summary>
    public const string OutdatedProblem = "База хранится в прежнем формате. Перевести её можно в разделе «Проблемы баз».";

    /// <summary>База прежнего формата — её переводит кит (B-314).</summary>
    public static bool IsOutdated(string basePath) => ReadFormat(basePath) < Format;

    /// <summary>
    /// Копии этой машины в базе любого формата — от копии идёт перевод базы прежнего формата (B-314). Список копий кит
    /// с форматами переносил: с формата 3 он в local\me.json, в формате 2 — в local\workspaces.json
    /// (migrations/003-personal.ps1 кита), в формате 1 — в самом agents-kit.json (migrations/002-per-machine.ps1).
    /// </summary>
    public static IReadOnlyList<string> MachineCopies(string basePath) =>
        new[] { Path.Combine("local", "me.json"), Path.Combine("local", "workspaces.json"), MarkerFile }
            .Select(file => ReadWorkspacesFile(Path.Combine(basePath, file))?.Workspaces ?? [])
            .FirstOrDefault(copies => copies.Count > 0) ?? [];

    /// <summary>
    /// Имя оператора этой машины в local\me.json записано — какое бы ни было: поверх записанного имени кит другого
    /// не пишет (Set-KitOperatorName), и спрашивать его у оператора незачем.
    /// </summary>
    /// <summary>Оператор этой машины из local\me.json по форме кита; null — не назван или записан не по форме.</summary>
    public static string? MachineOperator(string basePath) =>
        ReadMachineFile(basePath)?.Operator is { } name && IsOperatorName(name) ? name : null;

    public static bool MachineOperatorNamed(string basePath) =>
        !string.IsNullOrWhiteSpace(ReadMachineFile(basePath)?.Operator);

    /// <summary>Имя оператора по форме кита (Test-KitOperatorName).</summary>
    public static bool IsOperatorName(string name) => OperatorName().IsMatch(name);

    /// <summary>Раскладка базы этой машины; null — читать нечего, почему — problem.</summary>
    public static BaseLayout? Read(string basePath) => Read(basePath, out _);

    public static BaseLayout? Read(string basePath, out string problem)
    {
        var format = ReadFormat(basePath);
        switch (format)
        {
            // Посреди конфликта сведения с сервером метки стоят в любом файле базы, и в agents-kit.json тоже: тогда
            // причина — конфликт. Метка без поломки разметки базу не гасит — она бывает и у бесконфликтного rebase
            // сведения, а о конфликте копии скажет сверка кита (Unmerged в «Проблемах баз»). local\me.json вне git.
            case null when Unmerged(basePath):
                problem = "Сведение базы с сервером встало на конфликте — сессии агентов не пишут в неё, пока его не разберут";
                return null;
            case null:
                problem = "Не прочитан agents-kit.json базы";
                return null;
            case < Format:
                problem = OutdatedProblem;
                return null;
        }

        var machine = ReadMachineFile(basePath);
        if (machine is null)
        {
            problem = @"Не прочитан local\me.json базы";
            return null;
        }
        if (machine.Operator is not { } name || !IsOperatorName(name))
        {
            problem = "На этом компьютере не назван оператор базы — возьмите проект под кит скиллом /onboard";
            return null;
        }

        var layout = new BaseLayout(basePath, name, machine.Workspaces) { NewerFormat = format > Format };
        // Как Test-KitPersonalRepo: .git бывает и файлом — у worktree и отдельного каталога git.
        var git = Path.Combine(layout.Personal, ".git");
        if (!Directory.Exists(git) && !File.Exists(git))
        {
            problem = "На этом компьютере нет личного репозитория оператора — возьмите проект под кит скиллом /onboard";
            return null;
        }

        problem = "";
        return layout;
    }

    /// <summary>Сведение репозитория с сервером не закончено — метки в его .git, как их смотрит кит (Test-KitUnmerged).</summary>
    private static bool Unmerged(string repo)
    {
        var git = Path.Combine(repo, ".git");
        return Directory.Exists(Path.Combine(git, "rebase-merge"))
            || Directory.Exists(Path.Combine(git, "rebase-apply"))
            || File.Exists(Path.Combine(git, "MERGE_HEAD"));
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
    private static MachineFile? ReadMachineFile(string basePath) =>
        ReadWorkspacesFile(Path.Combine(basePath, "local", "me.json"));

    /// <summary>JSON-объект с полями operator и workspaces: файла нет — пусто; не разбирается — null.</summary>
    private static MachineFile? ReadWorkspacesFile(string path)
    {
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
                    .Select(e => WorkspaceCollector.FullPath(e.GetString()!))
                    .ToList()
                : [];
            return new MachineFile(name, copies);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"[^\p{L}\p{Nd}]+")]
    private static partial Regex NotLetterOrDigit();

    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex OperatorName();
}
