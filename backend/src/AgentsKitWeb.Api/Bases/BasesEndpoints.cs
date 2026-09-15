using System.Text.Json;

namespace AgentsKitWeb.Api.Bases;

/// <summary>База в списке панели. Copies — число копий из agents-kit.json, null — файл не прочитан.</summary>
public sealed record BaseEntry(string Path, int? Copies);

public sealed record AddBaseRequest(string? Path);

public sealed record AddBaseRejectedResponse(string Problem);

public static class BasesEndpoints
{
    public static void MapBasesEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/bases", (BasesStore store) => store.List().Select(Entry).ToList());

        app.MapPost("/api/bases", (AddBaseRequest request, BasesStore store) =>
            store.Add(request.Path, out var added) switch
            {
                null => Results.Created((string?)null, Entry(added)),
                AddBaseProblem.Duplicate => Results.Conflict(new AddBaseRejectedResponse("duplicate")),
                var problem => Results.BadRequest(new AddBaseRejectedResponse(problem switch
                {
                    AddBaseProblem.Empty => "empty",
                    AddBaseProblem.NotFullPath => "not-full-path",
                    _ => "not-a-base",
                })),
            });

        app.MapDelete("/api/bases", (string path, BasesStore store) =>
            store.Remove(path) ? Results.NoContent() : Results.NotFound());
    }

    private static BaseEntry Entry(string path) => new(path, CountCopies(path));

    private static int? CountCopies(string basePath)
    {
        try
        {
            using var stream = File.OpenRead(Path.Combine(basePath, "agents-kit.json"));
            using var json = JsonDocument.Parse(stream);
            return json.RootElement.GetProperty("workspaces").GetArrayLength();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException
                                      or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }
}
