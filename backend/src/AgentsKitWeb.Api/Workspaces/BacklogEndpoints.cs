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

/// <summary>Артефакт записи бэклога — номером записи и номером строки в её «Артефактах», с адресом, который видело окно.</summary>
public sealed record OpenBacklogArtifactRequest(string Base, string Number, int Index, string Address);

public static class BacklogEndpoints
{
    public static void MapBacklogEndpoints(this IEndpointRouteBuilder app)
    {
        // Файл читается на каждый запрос: соседние сессии правят backlog.md прямо сейчас.
        app.MapGet("/api/backlog", (BasesStore bases) => bases.List().Select(Read).ToList());

        // Файл-артефакт записи открывается в VS Code окном на каталоге базы: копии у записи нет, а файл лежит
        // в artifacts/ базы. Как у артефакта задачи, запрос называет его номером, а не путём: файл, которого
        // нет в «Артефактах» записи, по HTTP не открыть.
        app.MapPost("/api/backlog/artifact/open", async (
            OpenBacklogArtifactRequest request,
            BasesStore bases,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            var file = basePath is null ? null : Path.Combine(basePath, Ask.BacklogWriteEndpoints.BacklogFile);
            if (file is null || !File.Exists(file))
                return Results.NotFound();

            var number = BacklogNumber.Normalize(request.Number);
            var artifacts = Backlog.Parse(await File.ReadAllTextAsync(file, cancellationToken))
                .FirstOrDefault(e => e.Number is not null && e.Number == number)?.Artifacts ?? [];
            if (request.Index < 0 || request.Index >= artifacts.Count || artifacts[request.Index].Address != request.Address)
                return Results.NotFound();

            var address = artifacts[request.Index].Address;
            if (Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                return Results.BadRequest(new OpenArtifactFailedResponse("not-a-file"));
            // У записи файл — только artifacts/<имя> базы; и путь туда не уходит с метасимволами cmd.
            if (address.IndexOfAny(OperatorEndpoints.CmdSpecial) >= 0 || ArtifactFiles.PathIn(basePath!, address) is not { } path)
                return Results.BadRequest(new OpenArtifactFailedResponse("unsafe-path"));
            if (!File.Exists(path))
                return Results.NotFound(new OpenArtifactFailedResponse("missing"));

            return await windows.OpenFileAsync(basePath!, path, cancellationToken)
                ? Results.NoContent()
                : Results.Json(new OpenArtifactFailedResponse("not-opened"), statusCode: StatusCodes.Status502BadGateway);
        });
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
