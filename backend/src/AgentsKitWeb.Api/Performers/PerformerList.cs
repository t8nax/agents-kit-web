using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Performers;

/// <summary>Файл исполнителя, найденный на диске: Name — то имя, которым зовёт его шаг флоу.</summary>
internal sealed record FoundPerformer(string Name, PerformerFields Fields, string Path);

/// <summary>
/// Что панель нашла в каталоге исполнителей базы и как из этого складывается список раздела.
/// Файл исполнителя живёт в базе проекта, а по рабочим копиям его развозит кит, поэтому строка
/// списка — это файл базы, и заведённые в базе помимо панели видны наравне с её собственными.
/// </summary>
internal static class PerformerList
{
    /// <summary>
    /// Исполнители проекта — все файлы каталога `agents` папки оператора этой машины в его базе. Имя — то, которым
    /// зовёт исполнителя шаг флоу: строка `name` файла, а её нет — имя самого файла. Базу панель не читает — их нет.
    /// </summary>
    public static List<Performer> OfProject(string basePath) =>
        BaseLayout.Read(basePath) is { } layout ? OfProject(layout) : [];

    public static List<Performer> OfProject(BaseLayout layout)
    {
        var performers = new List<Performer>();
        foreach (var file in Read(Directory(layout)))
            performers.Add(new Performer(
                file.Name,
                file.Fields.Description,
                file.Fields.Model,
                file.Fields.Tools,
                file.Fields.Prompt,
                file.Path));

        return performers.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Каталог исполнителей оператора — тот, откуда кит развозит их по его рабочим копиям.</summary>
    public static string Directory(BaseLayout layout) => System.IO.Path.Combine(layout.OperatorDir, Folder);

    public const string Folder = "agents";

    /// <summary>Файлы каталога исполнителей. Каталога нет или он не читается — исполнителей нет.</summary>
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
