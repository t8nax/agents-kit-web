using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Запись бэклога: номер, заголовок, текст оператору, поля кита и артефакты — подраздел «Артефакты» записи.
/// Part «Агенту» оператору не показывается. Поле пустое, когда шапка файла его не объявила или запись его
/// не несёт; Artifacts — null, когда артефактов у записи нет.
/// </summary>
public sealed record BacklogEntry(
    string? Number,
    string Title,
    string? Text,
    string? Priority = null,
    string? Type = null,
    IReadOnlyList<TaskArtifact>? Artifacts = null);

/// <summary>
/// Запись бэклога как она лежит в файле: от строки «## » до следующей такой строки или конца файла. Start и End —
/// смещения в тексте файла; Text — её строки без пустых в конце, через «\n». Number — номер в виде кита.
/// </summary>
public sealed record BacklogBlock(string? Number, int Start, int End, string Text);

public static partial class Backlog
{
    private const string AgentSection = "Агенту";
    internal const string ArtifactsSection = "Артефакты";
    private const string FieldsDeclaration = "поля:";
    private const string PriorityField = "приоритет";
    private const string TypeField = "тип";
    private const string CounterLine = "следующий номер:";

    // «ORD-8 Панель показывает бэклог базы» → («ORD-8», «Панель показывает бэклог базы»). Первое слово
    // заголовка — номер, только если оно номер по правилу кита (BacklogNumber): запись, написанную руками
    // кириллицей или строчными, панель узнаёт тем же номером.
    [GeneratedRegex(@"^(?<number>\S+)\s+(?<title>.+)$")]
    private static partial Regex NumberedTitle { get; }

    // Поле записи: «приоритет: высокий». Имя поля — до двоеточия, значение — после.
    [GeneratedRegex(@"^(?<name>[^:]+):(?<value>.*)$")]
    private static partial Regex FieldLine { get; }

    /// <summary>
    /// Записи файла backlog.md: раздел «##» — запись, «### Агенту» в ней обрывает текст оператору, строки
    /// «### Артефакты» идут в артефакты записи, а не в текст.
    /// </summary>
    public static IReadOnlyList<BacklogEntry> Parse(string text)
    {
        var fileLines = MemoryText.Lines(text).Select(l => l.Text).ToList();
        var declared = DeclaredFields(fileLines);

        var entries = new List<BacklogEntry>();
        // Заголовок открытой записи и строки её текста оператору; null — мы ещё в шапке файла.
        string? title = null;
        var lines = new List<string>();
        var artifacts = new List<TaskArtifact>();
        // Подраздел «###», в котором стоит строка: null — текст оператору до первого подраздела.
        string? section = null;
        // Поля стоят парами под заголовком, до текста оператору: с его первой строки их больше нет.
        var fields = new Dictionary<string, string>();
        var beforeText = true;

        void Close()
        {
            if (title is null)
                return;
            var match = NumberedTitle.Match(title);
            var number = match.Success ? BacklogNumber.Normalize(match.Groups["number"].Value) : null;
            var entryTitle = number is not null ? match.Groups["title"].Value.Trim() : title;
            entries.Add(new BacklogEntry(
                number,
                entryTitle,
                MemoryText.Block(lines),
                Field(fields, PriorityField),
                Field(fields, TypeField),
                artifacts.Count > 0 ? artifacts : null));
        }

        foreach (var line in fileLines)
        {
            if (line.StartsWith("## "))
            {
                Close();
                title = line[3..].Trim();
                lines = [];
                artifacts = [];
                fields = [];
                section = null;
                beforeText = true;
                continue;
            }

            if (title is null)
                continue;

            // «### Агенту» — не для оператора, «### Артефакты» — не текст, а список; прочий подраздел — снова текст.
            if (line.StartsWith("### "))
            {
                var name = line[4..].Trim();
                section = name is AgentSection or ArtifactsSection ? name : null;
                if (section is not null)
                    continue;
            }

            if (section is AgentSection)
                continue;
            if (section is ArtifactsSection)
            {
                if (WorkMemory.Artifact(line) is { } artifact)
                    artifacts.Add(artifact);
                continue;
            }

            if (beforeText)
            {
                if (line.Trim().Length == 0)
                    continue;
                if (NamedField(line, declared) is { } field)
                {
                    fields[field.Name] = field.Value;
                    continue;
                }
                beforeText = false;
            }

            lines.Add(line);
        }

        Close();
        return entries;
    }

    /// <summary>
    /// Записи файла с их границами: по ним панель заменяет или вырезает ровно одну запись и сверяет, что её
    /// текст не менялся. Пустые строки после записи входят в её границы, но не в текст.
    /// </summary>
    public static IReadOnlyList<BacklogBlock> Blocks(string text)
    {
        var blocks = new List<BacklogBlock>();
        var lines = MemoryText.Lines(text);
        int? open = null;

        void Close(int end)
        {
            if (open is not { } first)
                return;
            var own = lines.Skip(first).Take(end - first).Select(l => l.Text.TrimEnd()).ToList();
            while (own.Count > 1 && own[^1].Length == 0)
                own.RemoveAt(own.Count - 1);
            var match = NumberedTitle.Match(own[0][3..].Trim());
            var number = match.Success ? BacklogNumber.Normalize(match.Groups["number"].Value) : null;
            blocks.Add(new BacklogBlock(
                number, lines[first].Start, end < lines.Count ? lines[end].Start : text.Length, string.Join("\n", own)));
        }

        for (var i = 0; i < lines.Count; i++)
        {
            if (!lines[i].Text.StartsWith("## "))
                continue;
            Close(i);
            open = i;
        }
        Close(lines.Count);
        return blocks;
    }

    /// <summary>
    /// Буквы номеров проекта. Их держит счётчик «следующий номер:» в шапке файла. Счётчика нет — буквы те,
    /// что чаще всего у номеров записей, а при равенстве — у наибольшего номера: заголовок, начатый словом вида
    /// номера («HTTP-500 на оплате»), не перебивает буквы проекта. Номеров нет вовсе — букв панель не знает.
    /// </summary>
    public static string? Letters(string text)
    {
        foreach (var line in MemoryText.Lines(text).Select(l => l.Text))
        {
            if (line.StartsWith("## "))
                break;
            if (line.StartsWith(CounterLine) && BacklogNumber.Normalize(line[CounterLine.Length..]) is { } counter)
                return BacklogNumber.Letters(counter);
        }
        return Parse(text)
            .Select(e => e.Number)
            .OfType<string>()
            .GroupBy(BacklogNumber.Letters)
            .OrderByDescending(g => g.Count())
            .ThenByDescending(g => g.Max(BacklogNumber.Value))
            .FirstOrDefault()?.Key;
    }

    /// <summary>Буквы номеров проекта из backlog.md базы; файла нет или он не прочитан — null.</summary>
    public static string? ReadLetters(string basePath)
    {
        try
        {
            return Letters(File.ReadAllText(Path.Combine(basePath, "backlog.md")));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Поля, объявленные строкой «поля:» шапки файла — до первой записи. Строки нет — полей нет.</summary>
    private static IReadOnlyCollection<string> DeclaredFields(IEnumerable<string> lines)
    {
        foreach (var line in lines)
        {
            if (line.StartsWith("## "))
                break;
            if (!line.StartsWith(FieldsDeclaration))
                continue;
            return line[FieldsDeclaration.Length..]
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .ToHashSet();
        }
        return [];
    }

    // Пара «ключ: значение» с объявленным именем. Имя не объявлено — строка принадлежит тексту оператору.
    private static (string Name, string Value)? NamedField(string line, IReadOnlyCollection<string> declared)
    {
        var match = FieldLine.Match(line);
        if (!match.Success)
            return null;
        var name = match.Groups["name"].Value.Trim();
        return declared.Contains(name) ? (name, match.Groups["value"].Value.Trim()) : null;
    }

    // Объявленное поле, которого панель не знает, в текст оператору всё равно не идёт: оно служебное.
    private static string? Field(Dictionary<string, string> fields, string name) =>
        fields.TryGetValue(name, out var value) && value.Length > 0 ? value : null;
}
