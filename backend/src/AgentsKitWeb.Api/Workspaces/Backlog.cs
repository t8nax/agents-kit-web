using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Запись бэклога: номер, заголовок, текст оператору и поля кита. Part «Агенту» оператору не
/// показывается. Поле пустое, когда шапка файла его не объявила или запись его не несёт.
/// </summary>
public sealed record BacklogEntry(string? Number, string Title, string? Text, string? Priority = null, string? Type = null);

public static partial class Backlog
{
    private const string AgentSection = "Агенту";
    private const string FieldsDeclaration = "поля:";
    private const string PriorityField = "приоритет";
    private const string TypeField = "тип";

    // «B-8 Панель показывает бэклог базы» → («B-8», «Панель показывает бэклог базы»).
    // Кириллическая «В-8» — тот же номер: в заголовке она встречается, когда запись писали руками.
    [GeneratedRegex(@"^(?<number>[BВ]-\d+)\s+(?<title>.+)$")]
    private static partial Regex NumberedTitle { get; }

    // Поле записи: «приоритет: высокий». Имя поля — до двоеточия, значение — после.
    [GeneratedRegex(@"^(?<name>[^:]+):(?<value>.*)$")]
    private static partial Regex FieldLine { get; }

    /// <summary>Записи файла backlog.md: раздел «##» — запись, «### Агенту» в ней обрывает текст оператору.</summary>
    public static IReadOnlyList<BacklogEntry> Parse(string text)
    {
        var fileLines = MemoryText.Lines(text).Select(l => l.Text).ToList();
        var declared = DeclaredFields(fileLines);

        var entries = new List<BacklogEntry>();
        // Заголовок открытой записи и строки её текста оператору; null — мы ещё в шапке файла.
        string? title = null;
        var lines = new List<string>();
        var skipping = false;
        // Поля стоят парами под заголовком, до текста оператору: с его первой строки их больше нет.
        var fields = new Dictionary<string, string>();
        var beforeText = true;

        void Close()
        {
            if (title is null)
                return;
            var match = NumberedTitle.Match(title);
            var number = match.Success ? match.Groups["number"].Value : null;
            var entryTitle = match.Success ? match.Groups["title"].Value.Trim() : title;
            entries.Add(new BacklogEntry(
                number,
                entryTitle,
                MemoryText.Block(lines),
                Field(fields, PriorityField),
                Field(fields, TypeField)));
        }

        foreach (var line in fileLines)
        {
            if (line.StartsWith("## "))
            {
                Close();
                title = line[3..].Trim();
                lines = [];
                fields = [];
                skipping = false;
                beforeText = true;
                continue;
            }

            // Всё от «### Агенту» и до конца записи — не для оператора.
            if (line.StartsWith("### "))
                skipping = line[4..].Trim() == AgentSection;

            if (title is null || skipping)
                continue;

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
