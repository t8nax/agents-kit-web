using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Стадия флоу — файл flow/stages/&lt;слаг&gt;.md базы, один на все флоу, где она стоит. Slug — имя файла без .md;
/// у стадии, заведённой в панели и ещё не записанной, его нет. Description — описание как в файле.
/// </summary>
public sealed record FlowStage(
    string Title,
    string Executor,
    string Output,
    string? Skip,
    string? Description,
    IReadOnlyList<string>? Helpers = null,
    string? Slug = null)
{
    // Список record сравнивает ссылками, поэтому две одинаковые стадии вышли бы разными: равенство задано по значению.
    public bool Equals(FlowStage? other) =>
        other is not null
        && Title == other.Title
        && Executor == other.Executor
        && Output == other.Output
        && Skip == other.Skip
        && Description == other.Description
        && Slug == other.Slug
        && FlowFolder.Helpers(this).SequenceEqual(FlowFolder.Helpers(other));

    public override int GetHashCode() => HashCode.Combine(Title, Executor, Output, Skip, Description, Slug);
}

/// <summary>Возврат стадии во флоу: при Condition работа идёт заново к стадии Stage, стоящей в этом флоу раньше.</summary>
public sealed record StageReturn(string Condition, string Stage);

/// <summary>Пункт флоу: стадия по названию и её возвраты в этом флоу — у той же стадии в другом флоу они свои.</summary>
public sealed record FlowEntry(string Stage, IReadOnlyList<StageReturn>? Returns = null)
{
    public bool Equals(FlowEntry? other) =>
        other is not null && Stage == other.Stage && FlowFolder.Returns(this).SequenceEqual(FlowFolder.Returns(other));

    public override int GetHashCode() => Stage.GetHashCode();
}

/// <summary>Флоу — раздел «## имя» flow/flow.md: строка «когда» и стадии по порядку.</summary>
public sealed record NamedFlow(string Name, string? When, IReadOnlyList<FlowEntry> Entries)
{
    public bool Equals(NamedFlow? other) =>
        other is not null && Name == other.Name && When == other.When && Entries.SequenceEqual(other.Entries);

    public override int GetHashCode() => HashCode.Combine(Name, When);
}

/// <summary>
/// flow.md, разобранный целиком. Unread — строки, которые панель не сохранит: запись флоу их не воспроизводит
/// («строка N: «текст»»). Молча их не выбросить — при записи они пропали бы из базы, — поэтому с ними флоу не пишется.
/// Читается флоу так же, как его читает сверка кита (base-check.ps1, Get-KitFlowList).
/// </summary>
public sealed record FlowList(string Intro, IReadOnlyList<NamedFlow> Flows, IReadOnlyList<string> Unread);

/// <summary>Почему флоу не записан. Flow и Stage — где нашлось: имя флоу и название стадии.</summary>
public sealed record FlowFolderRejection(string Problem, string? Flow = null, string? Stage = null);

/// <summary>
/// Флоу базы в форме кита (reference/flow-stages.md): flow/flow.md — вступление и флоу со ссылками на стадии,
/// flow/stages/*.md — стадии, по файлу на стадию.
/// </summary>
public static partial class FlowFolder
{
    public const string Folder = "flow";
    public const string ListFile = "flow/flow.md";
    public const string StagesFolder = "flow/stages";

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    // Пункт флоу: «2. [Разведка](stages/research.md)».
    [GeneratedRegex(@"^\s*\d+\.\s*\[(?<title>[^\]]*)\]\((?<href>[^)]*)\)\s*$")]
    private static partial Regex EntryLine { get; }

    // Возврат и «когда» — в той же записи, что принимает сверка кита: с отступами и пробелом перед двоеточием.
    [GeneratedRegex(@"^\s+-\s+возврат\s*:\s*(?<value>.*)$")]
    private static partial Regex ReturnLine { get; }

    [GeneratedRegex(@"^\s*когда\s*:\s*(?<value>.*)$")]
    private static partial Regex WhenLine { get; }

    // «замечания — стадия «Реализация»» → условие и название стадии.
    [GeneratedRegex(@"^(?<condition>.*?)\s*—\s*стадия\s*«(?<stage>[^»]*)»\s*$")]
    private static partial Regex ReturnValue { get; }

    // Пара «ключ: значение» под заголовком стадии — как её видит сверка кита (Read-KitStage); пункт «1.» ключом не бывает.
    [GeneratedRegex(@"^(?<key>[^\s:][^:]*?)\s*:\s*(?<value>.*?)\s*$")]
    private static partial Regex KeyLine { get; }

    [GeneratedRegex(@"^\s*\d+(\.\d+)*\.\s")]
    private static partial Regex PointLine { get; }

    // Ключи стадии — закрытый перечень кита; возврат пишет флоу, а не стадия.
    private static readonly string[] StageKeys = ["исполнитель", "помощники", "выход", "пропуск"];

    /// <summary>Файл flow.md: вступление до первого флоу как в файле, флоу по порядку и непонятые строки.</summary>
    public static FlowList ParseList(string text, IReadOnlyDictionary<string, string> titlesBySlug)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var intro = new List<string>();
        var flows = new List<NamedFlow>();
        var unread = new List<string>();
        var i = 0;

        while (i < lines.Length && !lines[i].StartsWith("## "))
            intro.Add(lines[i++]);

        while (i < lines.Length)
        {
            var name = lines[i++][3..].Trim();
            string? when = null;
            var entries = new List<(string Stage, List<StageReturn> Returns)>();

            while (i < lines.Length && !lines[i].StartsWith("## "))
            {
                var number = i + 1;
                var line = lines[i++];
                if (line.Trim().Length == 0)
                    continue;
                if (WhenLine.Match(line) is { Success: true } whenMatch && entries.Count == 0 && when is null)
                    when = Nullable(whenMatch.Groups["value"].Value) ?? "";
                else if (EntryLine.Match(line) is { Success: true } entry
                         && SlugOf(entry.Groups["href"].Value.Trim()) is { } slug)
                {
                    // Пункт адресует файл стадии; название берётся из заголовка файла, а нет файла — из текста ссылки.
                    var title = titlesBySlug.TryGetValue(slug, out var known) ? known : entry.Groups["title"].Value.Trim();
                    entries.Add((title, []));
                }
                else if (ReturnLine.Match(line) is { Success: true } back && entries.Count > 0)
                    entries[^1].Returns.Add(ParseReturn(back.Groups["value"].Value.Trim()));
                else
                    unread.Add($"строка {number}: «{line.Trim()}»");
            }

            flows.Add(new NamedFlow(name, Nullable(when ?? ""), entries.Select(e => new FlowEntry(e.Stage, e.Returns)).ToList()));
        }

        return new FlowList(Raw(intro), flows, unread);
    }

    /// <summary>Флоу базы по её flow/flow.md — только имена, «когда» и названия пунктов. Флоу нет или файл не прочитан — пусто.</summary>
    public static IReadOnlyList<NamedFlow> ReadFlows(string basePath)
    {
        try
        {
            var list = Path.Combine(basePath, ListFile);
            return File.Exists(list) ? ParseList(Decode(File.ReadAllBytes(list)).Text, new Dictionary<string, string>()).Flows : [];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Файл стадии: заголовок «# Название», ключи под ним и описание после пустой строки.</summary>
    public static FlowStage ParseStage(string text, string slug) => ReadStage(text, slug).Stage;

    /// <summary>
    /// Стадия и строки её файла, которые панель не сохранит: текст до заголовка, файл без заголовка, ключ вне перечня
    /// кита, повтор ключа. При записи стадии они пропали бы, поэтому с ними флоу не пишется. Читается стадия так же,
    /// как её читает сверка кита (base-check.ps1, Read-KitStage): ключи идут под заголовком до пустой строки.
    /// </summary>
    public static (FlowStage Stage, IReadOnlyList<string> Unread) ReadStage(string text, string slug)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var unread = new List<string>();
        var i = 0;
        while (i < lines.Length && !lines[i].StartsWith("# "))
        {
            if (lines[i].Trim().Length > 0)
                unread.Add($"строка {i + 1}: «{lines[i].Trim()}»");
            i++;
        }
        if (i == lines.Length)
            unread.Add("нет заголовка «# Название»");
        var title = i < lines.Length ? lines[i++][2..].Trim() : "";

        var keys = new Dictionary<string, string>();
        var paired = false;
        while (i < lines.Length)
        {
            if (lines[i].Trim().Length == 0)
            {
                if (paired)
                    break;
                i++;
                continue;
            }
            if (PointLine.IsMatch(lines[i]) || KeyLine.Match(lines[i]) is not { Success: true } key)
                break;

            var name = key.Groups["key"].Value;
            if (!StageKeys.Contains(name))
                unread.Add($"строка {i + 1}: ключ вне перечня «{lines[i].Trim()}»");
            // Повтор ключа кит берёт последним, а запись оставит одну строку: прежняя пропала бы.
            else if (!keys.TryAdd(name, key.Groups["value"].Value))
            {
                keys[name] = key.Groups["value"].Value;
                unread.Add($"строка {i + 1}: ключ «{name}» второй раз");
            }
            paired = true;
            i++;
        }

        var stage = new FlowStage(
            title,
            keys.GetValueOrDefault("исполнитель", ""),
            keys.GetValueOrDefault("выход", ""),
            Nullable(keys.GetValueOrDefault("пропуск", "")),
            Block(lines[i..]),
            ParseHelpers(keys.GetValueOrDefault("помощники", "")),
            slug);
        return (stage, unread);
    }

    /// <summary>Текст flow.md: вступление как было, флоу с пунктами подряд с единицы.</summary>
    public static string SerializeList(string intro, IReadOnlyList<NamedFlow> flows, IReadOnlyDictionary<string, string> slugsByTitle, string eol = "\n")
    {
        var parts = new List<string>();
        if (intro.Length > 0)
            parts.Add(intro);

        foreach (var flow in flows)
        {
            var block = new StringBuilder($"## {flow.Name.Trim()}");
            if (!string.IsNullOrWhiteSpace(flow.When))
                block.Append($"\nкогда: {flow.When.Trim()}");
            for (var index = 0; index < flow.Entries.Count; index++)
            {
                var entry = flow.Entries[index];
                block.Append($"\n{index + 1}. [{entry.Stage.Trim()}](stages/{slugsByTitle[Key(entry.Stage)]}.md)");
                foreach (var back in Returns(entry))
                    block.Append($"\n   - возврат: {back.Condition.Trim()} — стадия «{back.Stage.Trim()}»");
            }
            parts.Add(block.ToString());
        }

        return (string.Join("\n\n", parts) + "\n").Replace("\n", eol);
    }

    /// <summary>Текст файла стадии в форме кита.</summary>
    public static string SerializeStage(FlowStage stage, string eol = "\n")
    {
        var text = new StringBuilder($"# {stage.Title.Trim()}\n\n");
        text.Append($"исполнитель: {stage.Executor.Trim()}\n");
        // Порядок ключей — как в справке кита: помощники сразу за исполнителем.
        if (Helpers(stage) is { Count: > 0 } helpers)
            text.Append($"помощники: {string.Join(", ", helpers)}\n");
        text.Append($"выход: {stage.Output.Trim()}");
        if (!string.IsNullOrWhiteSpace(stage.Skip))
            text.Append($"\nпропуск: {stage.Skip.Trim()}");
        if (Block(stage.Description?.Replace("\r\n", "\n").Split('\n') ?? []) is { } description)
            text.Append("\n\n").Append(description);
        return (text + "\n").Replace("\n", eol);
    }

    /// <summary>Первое, из-за чего кит счёл бы флоу сломанным (красные находки сверки); null — всё годится.</summary>
    public static FlowFolderRejection? Validate(IReadOnlyList<FlowStage> stages, IReadOnlyList<NamedFlow> flows)
    {
        var titles = new HashSet<string>();
        foreach (var stage in stages)
        {
            if (StageProblem(stage) is { } problem)
                return new FlowFolderRejection(problem, Stage: stage.Title);
            if (!titles.Add(Key(stage.Title)))
                return new FlowFolderRejection("stage-duplicate-title", Stage: stage.Title);
        }

        var names = new HashSet<string>();
        foreach (var flow in flows)
        {
            FlowFolderRejection Reject(string problem, string? stage = null) => new(problem, flow.Name, stage);

            if (string.IsNullOrWhiteSpace(flow.Name))
                return Reject("flow-empty-name");
            if (!names.Add(Key(flow.Name)))
                return Reject("flow-duplicate-name");
            if (Breaks(flow.Name) || Breaks(flow.When ?? ""))
                return Reject("line-break");
            if (flows.Count > 1 && string.IsNullOrWhiteSpace(flow.When))
                return Reject("flow-without-when");
            if (flow.Entries.Count == 0)
                return Reject("flow-without-stages");

            var placed = new List<string>();
            foreach (var entry in flow.Entries)
            {
                if (!titles.Contains(Key(entry.Stage)))
                    return Reject("stage-unknown", entry.Stage);
                if (placed.Contains(Key(entry.Stage)))
                    return Reject("stage-twice", entry.Stage);
                foreach (var back in Returns(entry))
                {
                    if (string.IsNullOrWhiteSpace(back.Condition))
                        return Reject("return-without-condition", entry.Stage);
                    if (Breaks(back.Condition) || Breaks(back.Stage))
                        return Reject("line-break", entry.Stage);
                    if (!flow.Entries.Any(e => Key(e.Stage) == Key(back.Stage)) || back.Stage.Trim().Length == 0)
                        return Reject("return-unknown-stage", entry.Stage);
                    if (!placed.Contains(Key(back.Stage)))
                        return Reject("return-stage-not-earlier", entry.Stage);
                }
                placed.Add(Key(entry.Stage));
            }
        }
        return null;
    }

    /// <summary>Что в самой стадии кит не примет; null — годится.</summary>
    public static string? StageProblem(FlowStage stage) =>
        string.IsNullOrWhiteSpace(stage.Title) ? "stage-empty-title"
        : string.IsNullOrWhiteSpace(stage.Executor) ? "stage-empty-executor"
        : string.IsNullOrWhiteSpace(stage.Output) ? "stage-empty-output"
        : new[] { stage.Title, stage.Executor, stage.Output, stage.Skip ?? "" }.Concat(Helpers(stage)).Any(Breaks) ? "line-break"
        // Название стоит текстом ссылки «[Название](…)» и в возврате «стадия «Название»»: скобки и кавычки его разорвут.
        : stage.Title.IndexOfAny(['[', ']', '«', '»']) >= 0 ? "stage-bad-title"
        : Helpers(stage).Count > 0 && stage.Executor.Trim() != "оркестратор" ? "helpers-not-orchestrator"
        : null;

    /// <summary>
    /// Название стадии и имя флоу как адрес — как у сверки кита (base-check.ps1): подряд идущие пробелы — один,
    /// по краям их нет, регистр не важен.
    /// </summary>
    public static string Key(string name) => Regex.Replace(name, @"\s+", " ").Trim().ToLowerInvariant();

    public static IReadOnlyList<StageReturn> Returns(FlowEntry entry) => entry.Returns ?? [];

    public static IReadOnlyList<string> Helpers(FlowStage stage) =>
        (stage.Helpers ?? []).Select(h => h.Trim()).Where(h => h.Length > 0).ToList();

    /// <summary>
    /// Отпечаток флоу базы — по flow.md и всем файлам стадий: запись принимается только поверх того,
    /// что оператор видел, а правка любого из файлов его сдвигает.
    /// </summary>
    public static string Fingerprint(IEnumerable<(string Path, byte[] Bytes)> files)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var (path, bytes) in files.OrderBy(f => f.Path, StringComparer.Ordinal))
        {
            hash.AppendData(Encoding.UTF8.GetBytes(path + "\0"));
            hash.AppendData(bytes);
            hash.AppendData([0]);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    /// <summary>Слаг новой стадии из её названия: латиница, цифры и дефисы; занятый получает номер.</summary>
    public static string NewSlug(string title, ICollection<string> taken)
    {
        var latin = new StringBuilder();
        foreach (var c in title.Trim().ToLowerInvariant())
            latin.Append(Translit.TryGetValue(c, out var t) ? t : char.IsAsciiLetterOrDigit(c) ? c.ToString() : "-");
        var slug = Regex.Replace(latin.ToString(), "-+", "-").Trim('-');
        if (slug.Length == 0)
            slug = "stage";

        var candidate = slug;
        for (var n = 2; taken.Contains(candidate); n++)
            candidate = $"{slug}-{n}";
        return candidate;
    }

    /// <summary>Текст файла без BOM; HasBom — писать ли его обратно.</summary>
    public static (string Text, bool HasBom) Decode(byte[] bytes)
    {
        var hasBom = bytes.AsSpan().StartsWith(Utf8Bom);
        var offset = hasBom ? Utf8Bom.Length : 0;
        return (new UTF8Encoding(false).GetString(bytes, offset, bytes.Length - offset), hasBom);
    }

    public static byte[] Encode(string text, bool hasBom)
    {
        var bytes = new UTF8Encoding(false).GetBytes(text);
        return hasBom ? [.. Utf8Bom, .. bytes] : bytes;
    }

    private static bool Breaks(string value) => value.Contains('\n') || value.Contains('\r');

    // «stages/research.md» → «research»; адрес не в каталог стадий — null.
    private static string? SlugOf(string href) =>
        href.StartsWith("stages/") && href.EndsWith(".md") && !href[7..].Contains('/') ? href[7..^3] : null;

    private static StageReturn ParseReturn(string value) =>
        ReturnValue.Match(value) is { Success: true } match
            ? new StageReturn(match.Groups["condition"].Value.Trim(), match.Groups["stage"].Value.Trim())
            : new StageReturn(value, "");

    private static IReadOnlyList<string> ParseHelpers(string value) =>
        value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    private static string? Nullable(string value) => value.Trim().Length > 0 ? value.Trim() : null;

    // Вступление как в файле, строка в строку, с пробелами в концах строк: в markdown два пробела — перенос.
    // Срезаются только пустые строки по краям — между вступлением и флоу запись ставит одну свою.
    private static string Raw(List<string> lines)
    {
        var first = lines.FindIndex(l => l.Trim().Length > 0);
        return first < 0 ? "" : string.Join("\n", lines[first..(lines.FindLastIndex(l => l.Trim().Length > 0) + 1)]);
    }

    // Строки как в файле, без пустых по краям; null — текста нет.
    private static string? Block(IEnumerable<string> lines)
    {
        var block = lines.Select(l => l.TrimEnd()).ToList();
        var first = block.FindIndex(l => l.Length > 0);
        return first < 0 ? null : string.Join("\n", block[first..(block.FindLastIndex(l => l.Length > 0) + 1)]);
    }

    private static readonly Dictionary<char, string> Translit = new()
    {
        ['а'] = "a", ['б'] = "b", ['в'] = "v", ['г'] = "g", ['д'] = "d", ['е'] = "e", ['ё'] = "e", ['ж'] = "zh",
        ['з'] = "z", ['и'] = "i", ['й'] = "y", ['к'] = "k", ['л'] = "l", ['м'] = "m", ['н'] = "n", ['о'] = "o",
        ['п'] = "p", ['р'] = "r", ['с'] = "s", ['т'] = "t", ['у'] = "u", ['ф'] = "f", ['х'] = "h", ['ц'] = "ts",
        ['ч'] = "ch", ['ш'] = "sh", ['щ'] = "sch", ['ъ'] = "", ['ы'] = "y", ['ь'] = "", ['э'] = "e", ['ю'] = "yu",
        ['я'] = "ya",
    };
}
