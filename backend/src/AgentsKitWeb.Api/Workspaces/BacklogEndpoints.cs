using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Бэклог одной базы. Error задан — записей панель не прочитала. Letters — буквы номеров проекта
/// (Backlog.Letters): запись с другими буквами задачей не запускается; null — букв панель не знает.
/// </summary>
public sealed record BaseBacklog(
    string Base,
    string Project,
    IReadOnlyList<BacklogEntry> Entries,
    string? Error,
    string? Letters = null);

public static class BacklogEndpoints
{
    public static void MapBacklogEndpoints(this IEndpointRouteBuilder app)
    {
        // Файл читается на каждый запрос: соседние сессии правят backlog.md прямо сейчас.
        app.MapGet("/api/backlog", (BasesStore bases) => bases.List().Select(Read).ToList());
    }

    private static BaseBacklog Read(string basePath)
    {
        var project = ProjectName.Of(basePath);

        if (!Directory.Exists(basePath))
            return new BaseBacklog(basePath, project, [], "База не найдена на диске");

        var file = Path.Combine(basePath, "backlog.md");
        if (!File.Exists(file))
            return new BaseBacklog(basePath, project, [], "В базе нет backlog.md");

        try
        {
            var text = File.ReadAllText(file);
            return new BaseBacklog(basePath, project, Backlog.Parse(text), null, Backlog.Letters(text));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BaseBacklog(basePath, project, [], "Бэклог базы не прочитан");
        }
    }
}
