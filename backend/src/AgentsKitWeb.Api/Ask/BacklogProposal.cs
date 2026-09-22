using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Одна правка предложения. Kind — change (запись станет Entry) или delete (запись Entry уходит; Into — в какую
/// запись она влита при объединении). Text — новый текст записи в файле, Original — её текст, каким его видел
/// агент: по нему «Сохранить» узнаёт, что запись успели поменять.
/// </summary>
public sealed record BacklogChange(string Kind, string Number, BacklogEntry Entry, string? Into = null)
{
    public const string Change = "change";
    public const string Delete = "delete";

    [JsonIgnore]
    public string? Text { get; init; }

    [JsonIgnore]
    public string Original { get; init; } = "";
}

/// <summary>
/// Изменение, удаление и объединение записей, которые агент не пишет в файл, а предлагает: пишет их панель
/// по «Сохранить» — решение оператора на B-72.
/// </summary>
public sealed record BacklogProposal(string Id, IReadOnlyList<BacklogChange> Changes)
{
    // Блок предложения в ответе агента: «~~~backlog», строка команды, для «изменить» — запись целиком, «~~~».
    // Тильды, а не обратные кавычки: в тексте записи бывают свои блоки кода.
    private static readonly Regex BlockPattern = new(
        @"^~~~backlog[ \t]*\r?\n(?<body>.*?)^~~~[ \t]*$", RegexOptions.Multiline | RegexOptions.Singleline);

    private static readonly Regex DeleteCommand = new(@"^удалить\s+(?<number>\S+)(?:\s+в\s+(?<into>\S+))?$");

    private static readonly Regex ChangeCommand = new(@"^изменить\s+(?<number>\S+)$");

    /// <summary>Ответ агента без блоков предложения и сами блоки по порядку.</summary>
    public static (string Text, IReadOnlyList<string> Blocks) Split(string answer)
    {
        answer = answer.ReplaceLineEndings("\n");
        var blocks = BlockPattern.Matches(answer).Select(m => m.Groups["body"].Value).ToList();
        var text = BlockPattern.Replace(answer, "");
        text = Regex.Replace(text, @"\n{3,}", "\n\n").Trim();
        return (text, blocks);
    }

    /// <summary>
    /// Предложение из блоков ответа, сверенное с файлом: номера есть в бэклоге, номер изменённой записи тот же,
    /// запись названа один раз. Не сошлось — Error со словами, что не так; блоков нет — ни того ни другого.
    /// </summary>
    public static (BacklogProposal? Proposal, string? Error) Build(IReadOnlyList<string> blocks, string file)
    {
        if (blocks.Count == 0)
            return (null, null);

        var entries = Backlog.Blocks(file);
        var header = entries.Count > 0 ? file[..entries[0].Start] : file;
        var changes = new List<BacklogChange>();

        foreach (var block in blocks)
        {
            var lines = block.TrimEnd('\n').Split('\n');
            var command = lines[0].Trim();
            var body = string.Join("\n", lines.Skip(1)).Trim('\n');

            if (DeleteCommand.Match(command) is { Success: true } delete)
            {
                var number = BacklogNumber.Normalize(delete.Groups["number"].Value);
                var into = delete.Groups["into"].Success ? BacklogNumber.Normalize(delete.Groups["into"].Value) : null;
                if (Find(entries, number) is not { } original)
                    return (null, $"Записи {delete.Groups["number"].Value} в бэклоге нет");
                if (delete.Groups["into"].Success && (into is null || into == number || Find(entries, into) is null))
                    return (null, $"Записи {delete.Groups["into"].Value}, в которую уходит {number}, в бэклоге нет");
                changes.Add(new BacklogChange(BacklogChange.Delete, number!, Entry(header, original.Text), into)
                {
                    Original = original.Text,
                });
                continue;
            }

            if (ChangeCommand.Match(command) is { Success: true } change)
            {
                var number = BacklogNumber.Normalize(change.Groups["number"].Value);
                if (Find(entries, number) is not { } original)
                    return (null, $"Записи {change.Groups["number"].Value} в бэклоге нет");
                var own = Backlog.Blocks(body);
                if (own.Count != 1 || own[0].Start != 0 || own[0].Number != number)
                    return (null, $"Изменённая запись {number} должна начинаться строкой «## {number} …» и быть одна");
                changes.Add(new BacklogChange(BacklogChange.Change, number!, Entry(header, own[0].Text))
                {
                    Text = own[0].Text,
                    Original = original.Text,
                });
                continue;
            }

            return (null, $"Непонятная строка предложения: «{command}»");
        }

        if (changes.GroupBy(c => c.Number).FirstOrDefault(g => g.Count() > 1) is { } twice)
            return (null, $"Запись {twice.Key} названа в предложении дважды");
        return (new BacklogProposal(Guid.NewGuid().ToString("N"), changes), null);
    }

    /// <summary>
    /// Файл с правками предложения: запись меняется на месте, удалённая вырезается вместе с пустыми строками
    /// после неё, остальное остаётся байт в байт. null и номер — запись в файле уже не та, что видел агент.
    /// </summary>
    public (string? Text, string? Diverged) Apply(string file)
    {
        var entries = Backlog.Blocks(file);
        var newline = file.Contains("\r\n") ? "\r\n" : "\n";
        var edits = new List<(int Start, int End, string Text)>();
        var lastCut = false;

        foreach (var change in Changes)
        {
            if (Find(entries, change.Number) is not { } block || block.Text != change.Original)
                return (null, change.Number);

            var range = file[block.Start..block.End];
            var tail = range[range.TrimEnd().Length..];
            if (change.Kind == BacklogChange.Change)
                edits.Add((block.Start, block.End, change.Text!.Replace("\n", newline) + tail));
            else
            {
                edits.Add((block.Start, block.End, ""));
                lastCut |= block.End == file.Length;
            }
        }

        var text = file;
        foreach (var edit in edits.OrderByDescending(e => e.Start))
            text = text[..edit.Start] + edit.Text + text[edit.End..];
        // Вырезана последняя запись: пустые строки перед ней остались бы висеть в конце файла.
        return (lastCut ? text.TrimEnd() + newline : text, null);
    }

    private static BacklogBlock? Find(IReadOnlyList<BacklogBlock> entries, string? number) =>
        number is null ? null : entries.FirstOrDefault(e => e.Number == number);

    // Шапка файла нужна разбору: без её строки «поля:» тип и приоритет записи ушли бы в текст оператору.
    private static BacklogEntry Entry(string header, string text) => Backlog.Parse(header + "\n" + text)[0];
}
