namespace AgentsKitWeb.Api.Performers;

/// <summary>Файл исполнителя, найденный на диске. Text — как он лежит: по нему видно, что копии разошлись.</summary>
internal sealed record FoundPerformer(string Name, PerformerFields Fields, string Path, string Text);

/// <summary>
/// Что панель нашла на диске и как из этого складывается список раздела. Один и тот же исполнитель,
/// лежащий в нескольких копиях, показан одной строкой: файл — про проект, а не про копию, и строка
/// на копию говорила бы о нём то же самое по нескольку раз.
/// </summary>
internal static class PerformerList
{
    /// <summary>
    /// Исполнители копий проекта, схлопнутые по имени. Поля берутся из основной копии, а нет файла
    /// там — из первой копии, где он нашёлся: показать нечего только тогда, когда его нет нигде.
    /// </summary>
    public static List<Performer> OfCopies(IReadOnlyList<PerformerCopy> copies)
    {
        var places = new Dictionary<string, List<(PerformerCopy Copy, FoundPerformer File)>>(StringComparer.Ordinal);
        foreach (var copy in copies)
            foreach (var file in Read(AgentsDirectory(copy.Path)))
            {
                if (!places.TryGetValue(file.Name, out var found))
                    places[file.Name] = found = [];
                found.Add((copy, file));
            }

        var performers = new List<Performer>();
        foreach (var name in places.Keys.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
        {
            var found = places[name];
            var source = found.FirstOrDefault(place => place.Copy.Main, found[0]);
            var differs = found
                .Where(place => !SameText(place.File.Text, source.File.Text))
                .Select(place => place.Copy.Path)
                .ToList();
            var into = found.Select(place => place.Copy.Path).ToList();

            performers.Add(Performer(
                source.File,
                "copy",
                source.Copy.Path,
                into,
                differs,
                into.Count == copies.Count && differs.Count == 0));
        }
        return performers;
    }

    /// <summary>
    /// Исполнители профиля оператора: панель их показывает, чтобы шаг флоу не считал их пропавшими.
    /// Синхронизировать их не надо — из любой копии их видно и так, поэтому Everywhere у них true.
    /// </summary>
    public static List<Performer> OfProfile(string claudeDir) =>
        Read(System.IO.Path.Combine(claudeDir, "agents"))
            .Select(file => Performer(file, "profile", null, [], [], true))
            .ToList();

    /// <summary>Каталог субагентов копии — тот, где их ищет Claude Code.</summary>
    public static string AgentsDirectory(string copyPath) =>
        System.IO.Path.Combine(copyPath, PerformerFile.Directory.Replace('/', '\\'));

    /// <summary>
    /// Файл копии считается тем же, когда текст сходится с точностью до переводов строк и краёв:
    /// копии выкачаны разными настройками autocrlf, и расхождением это называть незачем.
    /// </summary>
    public static bool SameText(string left, string right) =>
        string.Equals(left.ReplaceLineEndings("\n").Trim(), right.ReplaceLineEndings("\n").Trim(), StringComparison.Ordinal);

    /// <summary>Файлы каталога субагентов. Каталога нет или он не читается — исполнителей нет.</summary>
    public static List<FoundPerformer> Read(string directory)
    {
        var found = new List<FoundPerformer>();
        if (!System.IO.Directory.Exists(directory))
            return found;

        IEnumerable<string> files;
        try
        {
            files = System.IO.Directory.EnumerateFiles(directory, "*.md").OrderBy(f => f, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return found;
        }

        foreach (var file in files)
        {
            string text;
            try
            {
                text = File.ReadAllText(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            var fields = PerformerFile.Parse(text);
            found.Add(new FoundPerformer(
                // Шаг флоу зовёт субагента именем из поля name; его нет — Claude Code берёт имя файла.
                fields.Name ?? System.IO.Path.GetFileNameWithoutExtension(file),
                fields,
                file,
                text));
        }
        return found;
    }

    private static Performer Performer(
        FoundPerformer file,
        string source,
        string? copy,
        IReadOnlyList<string> into,
        IReadOnlyList<string> differs,
        bool everywhere) =>
        new(file.Name,
            file.Fields.Description,
            file.Fields.Model,
            file.Fields.Tools,
            file.Fields.Prompt,
            file.Path,
            source,
            copy,
            into,
            differs,
            everywhere);
}
