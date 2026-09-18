using System.Text;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Файл исполнителя — субагент Claude Code: шапка `---` с ключами и задание под ней.
/// Панель читает из шапки имя, описание, модель и инструменты; чего в шапке нет, то null.
/// </summary>
public sealed record PerformerFields(
    string? Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt);

public static class PerformerFile
{
    /// <summary>Каталог субагентов — тот, где их ищет Claude Code, и в копии, и в профиле.</summary>
    public const string Directory = ".claude/agents";

    /// <summary>Имя файла — имя субагента: во флоу шаг зовёт его именно так.</summary>
    public static string FileName(string name) => name + ".md";

    /// <summary>
    /// Разбирает файл. Шапки нет — весь текст считается заданием, а полей нет: такой файл
    /// Claude Code субагентом не считает, и панель показывает его именем файла.
    /// </summary>
    public static PerformerFields Parse(string text)
    {
        var lines = text.ReplaceLineEndings("\n").Split('\n');
        if (lines.Length == 0 || lines[0].Trim() != "---")
            return new PerformerFields(null, null, null, null, text.Trim());

        var close = Array.FindIndex(lines, 1, line => line.Trim() == "---");
        if (close < 0)
            return new PerformerFields(null, null, null, null, text.Trim());

        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < close; i++)
        {
            var separator = lines[i].IndexOf(':');
            if (separator <= 0)
                continue;
            var key = lines[i][..separator].Trim();
            var value = lines[i][(separator + 1)..].Trim().Trim('"', '\'');
            if (key.Length > 0)
                fields[key] = value;
        }

        return new PerformerFields(
            Value(fields, "name"),
            Value(fields, "description"),
            Value(fields, "model"),
            Value(fields, "tools"),
            string.Join("\n", lines.Skip(close + 1)).Trim());
    }

    /// <summary>
    /// Собирает файл обратно. Пустые поля в шапку не пишутся: у модели и инструментов пусто значит
    /// «как у сессии», и ключ с пустым значением Claude Code понял бы иначе.
    /// </summary>
    public static string Serialize(PerformerFields fields, string newline = "\n")
    {
        var header = new StringBuilder();
        header.Append("---").Append(newline);
        Append(header, "name", fields.Name, newline);
        Append(header, "description", fields.Description, newline);
        Append(header, "tools", fields.Tools, newline);
        Append(header, "model", fields.Model, newline);
        header.Append("---").Append(newline).Append(newline);
        header.Append(fields.Prompt.ReplaceLineEndings(newline).Trim()).Append(newline);
        return header.ToString();
    }

    /// <summary>
    /// Имя годится в имя субагента и в имя файла: строчные латинские буквы, цифры и дефис.
    /// Так же зовут субагентов сами скиллы кита, и по такому имени шаг флоу его находит.
    /// </summary>
    public static bool ValidName(string? name) =>
        !string.IsNullOrEmpty(name)
        && name.Length <= 64
        && char.IsAsciiLetterLower(name[0])
        && name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-')
        && !name.EndsWith('-');

    private static string? Value(IReadOnlyDictionary<string, string> fields, string key) =>
        fields.TryGetValue(key, out var value) && value.Length > 0 ? value : null;

    private static void Append(StringBuilder header, string key, string? value, string newline)
    {
        if (!string.IsNullOrWhiteSpace(value))
            header.Append(key).Append(": ").Append(value.Trim()).Append(newline);
    }
}
