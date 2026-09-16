using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Запись бэклога: номер, заголовок и текст оператору. Part «Агенту» оператору не показывается.</summary>
public sealed record BacklogEntry(string? Number, string Title, string? Text);

public static partial class Backlog
{
    private const string AgentSection = "Агенту";

    // «B-8 Панель показывает бэклог базы» → («B-8», «Панель показывает бэклог базы»).
    // Кириллическая «В-8» — тот же номер: в заголовке она встречается, когда запись писали руками.
    [GeneratedRegex(@"^(?<number>[BВ]-\d+)\s+(?<title>.+)$")]
    private static partial Regex NumberedTitle { get; }

    /// <summary>Записи файла backlog.md: раздел «##» — запись, «### Агенту» в ней обрывает текст оператору.</summary>
    public static IReadOnlyList<BacklogEntry> Parse(string text)
    {
        var entries = new List<BacklogEntry>();
        // Заголовок открытой записи и строки её текста оператору; null — мы ещё в шапке файла.
        string? title = null;
        var lines = new List<string>();
        var skipping = false;

        void Close()
        {
            if (title is null)
                return;
            var match = NumberedTitle.Match(title);
            entries.Add(match.Success
                ? new BacklogEntry(match.Groups["number"].Value, match.Groups["title"].Value.Trim(), MemoryText.Block(lines))
                : new BacklogEntry(null, title, MemoryText.Block(lines)));
        }

        foreach (var memoryLine in MemoryText.Lines(text))
        {
            var line = memoryLine.Text;

            if (line.StartsWith("## "))
            {
                Close();
                title = line[3..].Trim();
                lines = [];
                skipping = false;
                continue;
            }

            // Всё от «### Агенту» и до конца записи — не для оператора.
            if (line.StartsWith("### "))
                skipping = line[4..].Trim() == AgentSection;

            if (title is not null && !skipping)
                lines.Add(line);
        }

        Close();
        return entries;
    }
}
