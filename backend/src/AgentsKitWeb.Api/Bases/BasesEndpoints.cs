using System.Text.Json;

namespace AgentsKitWeb.Api.Bases;

/// <summary>База в списке панели. Copies — число копий из agents-kit.json, null — файл не прочитан.</summary>
public sealed record BaseEntry(string Path, int? Copies);

public sealed record AddBaseRequest(string? Path);

public sealed record AddBaseRejectedResponse(string Problem);

/// <summary>
/// Путь к установленному киту; null — не задан. Found — скрипты кита по пути на месте. Version — номер версии кита
/// по пути, null — не прочитан. Plugin — кит стоит плагином Claude Code. Update — установленная новая версия
/// плагина, на которую панель ещё не перешла: переходит только оператор.
/// </summary>
public sealed record KitResponse(string? Path, bool Found, string? Version = null, bool Plugin = false, KitVersion? Update = null);

public sealed record SetKitRequest(string? Path);

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

        app.MapGet("/api/kit", (BasesStore store, KitLocator locator) => store.Kit() is { } kit
            ? Kit(kit, locator)
            : new KitResponse(null, false));

        app.MapGet("/api/kit/found", (KitLocator locator) => locator.Find());

        app.MapPut("/api/kit", (SetKitRequest request, BasesStore store, KitLocator locator) =>
            store.SetKit(request.Path, out var saved) switch
            {
                null => Results.Ok(Kit(saved, locator)),
                var problem => Results.BadRequest(new AddBaseRejectedResponse(problem switch
                {
                    SetKitProblem.Empty => "empty",
                    SetKitProblem.NotFullPath => "not-full-path",
                    _ => "not-a-kit",
                })),
            });
    }

    private static BaseEntry Entry(string path) => new(path, CountCopies(path));

    private static KitResponse Kit(string kit, KitLocator locator)
    {
        var found = BasesStore.IsKit(kit);
        var plugin = locator.PluginState(kit);
        return new KitResponse(kit, found, found ? KitLocator.Version(kit) : null, plugin.Plugin, plugin.Update);
    }

    internal static int? CountCopies(string basePath)
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
