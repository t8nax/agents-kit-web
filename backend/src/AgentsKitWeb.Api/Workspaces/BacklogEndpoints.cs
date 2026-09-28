using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Бэклог одной базы. Error задан — записей панель не прочитала. Letters — буквы номеров проекта
/// (Backlog.Letters): запись с другими буквами задачей не запускается; null — букв панель не знает.
/// Tracker — трекер проекта из tracker.md базы; null — трекера у проекта нет. Задачи трекера приходят
/// отдельным запросом: их чтение идёт в GitHub и дольше чтения файла.
/// </summary>
public sealed record BaseBacklog(
    string Base,
    string Project,
    IReadOnlyList<BacklogEntry> Entries,
    string? Error,
    string? Letters = null,
    TrackerInfo? Tracker = null);

/// <summary>Артефакт записи бэклога — номером записи и номером строки в её «Артефактах», с адресом, который видело окно.</summary>
public sealed record OpenBacklogArtifactRequest(string Base, string Number, int Index, string Address);

public static class BacklogEndpoints
{
    public static void MapBacklogEndpoints(this IEndpointRouteBuilder app)
    {
        // Файл читается на каждый запрос: соседние сессии правят backlog.md прямо сейчас.
        app.MapGet("/api/backlog", (BasesStore bases) => bases.List().Select(Read).ToList());

        // Задачи трекера — своим запросом на базу: их читает gh из GitHub, и записи бэклога их не ждут.
        app.MapGet("/api/backlog/tracker", async (string @base, BasesStore bases, IGitHubIssues github, CancellationToken cancellationToken) =>
        {
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, @base));
            if (basePath is null || BaseLayout.Read(basePath) is not { } layout)
                return Results.NotFound();
            return Results.Ok(await TrackerIssuesOf(layout, github, cancellationToken));
        });

        // Файл-артефакт записи открывается в VS Code окном на каталоге базы: копии у записи нет, а файл лежит
        // в artifacts/ личного репозитория, рядом с бэклогом. Как у артефакта задачи, запрос называет его номером, а не путём: файл, которого
        // нет в «Артефактах» записи, по HTTP не открыть.
        app.MapPost("/api/backlog/artifact/open", async (
            OpenBacklogArtifactRequest request,
            BasesStore bases,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || BaseLayout.Read(basePath) is not { } layout || !File.Exists(layout.BacklogFile))
                return Results.NotFound();
            var file = layout.BacklogFile;

            var number = BacklogNumber.Normalize(request.Number);
            var artifacts = Backlog.Parse(await File.ReadAllTextAsync(file, cancellationToken))
                .FirstOrDefault(e => e.Number is not null && e.Number == number)?.Artifacts ?? [];
            if (request.Index < 0 || request.Index >= artifacts.Count || artifacts[request.Index].Address != request.Address)
                return Results.NotFound();

            var address = artifacts[request.Index].Address;
            if (Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                return Results.BadRequest(new OpenArtifactFailedResponse("not-a-file"));
            // У записи файл — только artifacts/<имя> личного репозитория; и путь туда не уходит с метасимволами cmd.
            if (address.IndexOfAny(OperatorEndpoints.CmdSpecial) >= 0 || ArtifactFiles.PathIn(layout.Personal, address) is not { } path)
                return Results.BadRequest(new OpenArtifactFailedResponse("unsafe-path"));
            if (!File.Exists(path))
                return Results.NotFound(new OpenArtifactFailedResponse("missing"));

            return await windows.OpenFileAsync(basePath, path, cancellationToken)
                ? Results.NoContent()
                : Results.Json(new OpenArtifactFailedResponse("not-opened"), statusCode: StatusCodes.Status502BadGateway);
        });
    }

    /// <summary>Открытые задачи трекера базы, назначенные на оператора; трекер не GitHub с адресом — Problem.</summary>
    public static async Task<TrackerIssues> TrackerIssuesOf(BaseLayout layout, IGitHubIssues github, CancellationToken cancellationToken) =>
        Tracker.Read(layout) switch
        {
            null => new TrackerIssues([], TrackerIssues.NoTracker),
            { Kind: TrackerInfo.GitHub, Repo: { } repo } => await github.AssignedAsync(repo, cancellationToken),
            var other => new TrackerIssues([], other.Kind),
        };

    private static BaseBacklog Read(string basePath)
    {
        var project = ProjectName.Of(basePath);

        if (!Directory.Exists(basePath))
            return new BaseBacklog(basePath, project, [], "База не найдена на диске");

        if (BaseLayout.Read(basePath, out var problem) is not { } layout)
            return new BaseBacklog(basePath, project, [], problem);

        var tracker = Tracker.Read(layout);
        var file = layout.BacklogFile;
        if (!File.Exists(file))
            return new BaseBacklog(basePath, project, [], "В личном репозитории нет backlog.md", Tracker: tracker);

        try
        {
            var text = File.ReadAllText(file);
            return new BaseBacklog(basePath, project, Backlog.Parse(text), null, Backlog.Letters(text), tracker);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BaseBacklog(basePath, project, [], "Бэклог базы не прочитан", Tracker: tracker);
        }
    }
}
