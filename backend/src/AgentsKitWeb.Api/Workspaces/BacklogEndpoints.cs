using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Бэклог одной базы. Error задан — записей панель не прочитала.</summary>
public sealed record BaseBacklog(
    string Base,
    string Project,
    IReadOnlyList<BacklogEntry> Entries,
    string? Error);

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
            return new BaseBacklog(basePath, project, Backlog.Parse(File.ReadAllText(file)), null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BaseBacklog(basePath, project, [], "Бэклог базы не прочитан");
        }
    }
}
