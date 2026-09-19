namespace AgentsKitWeb.Api.Performers;

/// <summary>Файл исполнителя, найденный на диске: Name — то имя, которым зовёт его шаг флоу.</summary>
internal sealed record FoundPerformer(string Name, PerformerFields Fields, string Path);

/// <summary>
/// Что панель нашла в наборе исполнителей Claude Code и как из этого складывается список раздела.
/// Файл у исполнителя один на машину, поэтому строка списка — это файл, и сверять копии не с чем.
/// </summary>
internal static class PerformerList
{
    /// <summary>
    /// Исполнители проекта: те файлы профиля, чьё имя начинается приставкой этого проекта. Имя
    /// в списке — без приставки: её ставит панель, и оператору она не показывается.
    /// </summary>
    public static List<Performer> OfProject(string claudeDir, string prefix)
    {
        var performers = new List<Performer>();
        if (prefix.Length == 0)
            return performers;

        foreach (var file in Read(Directory(claudeDir)))
            if (PerformerName.Short(prefix, file.Name) is { } name)
                performers.Add(new Performer(
                    name,
                    file.Fields.Description,
                    file.Fields.Model,
                    file.Fields.Tools,
                    file.Fields.Prompt,
                    file.Path));

        return performers.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Каталог субагентов профиля — тот, где их ищет Claude Code из любой рабочей копии.</summary>
    public static string Directory(string claudeDir) => System.IO.Path.Combine(claudeDir, "agents");

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
                file));
        }
        return found;
    }
}
