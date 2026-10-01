using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

public sealed record SaveTrackerServerRequest(string? Server, string? Key);

/// <summary>Отказ сохранить сервер: Problem — код причины, Detail — строка сервера трекера.</summary>
public sealed record TrackerServerProblem(string Problem, string? Detail = null);

public static class TrackerServersEndpoints
{
    public const string EmptyServer = "empty-server";
    public const string NotAddress = "not-address";
    public const string EmptyKey = "empty-key";
    public const string Duplicate = "duplicate";
    public const string FileBroken = "file-broken";

    /// <summary>
    /// Список «Серверы трекеров» в разделе «Трекеры». Ключ сохраняется, только когда сервер назвал его владельца:
    /// опечатка или отозванный ключ видны сразу под полем, а не потом в «Бэклоге» — решение оператора на B-288.
    /// Проверяет его YouTrack — других трекеров с ключом панель пока не читает.
    /// </summary>
    public static void MapTrackerServersEndpoints(this IEndpointRouteBuilder root)
    {
        // Битый trackers.json — отказ с его путём, а не пустой список: его не перезаписать молча (ревью B-288)
        var app = root.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            try
            {
                return await next(context);
            }
            catch (TrackersFileBroken broken)
            {
                return Results.Json(new TrackerServerProblem(FileBroken, broken.File), statusCode: StatusCodes.Status500InternalServerError);
            }
        });

        app.MapGet("/api/trackers", (TrackerServersStore servers) => servers.List());

        app.MapPost("/api/trackers", async (SaveTrackerServerRequest request, TrackerServersStore servers, IYouTrack youTrack, CancellationToken cancellationToken) =>
        {
            if (Invalid(request, out var server, out var key) is { } problem)
                return Results.BadRequest(problem);
            if (servers.Contains(server))
                return Results.Conflict(new TrackerServerProblem(Duplicate));
            return await CheckAndSaveAsync(server, key, servers, youTrack, cancellationToken);
        });

        app.MapPut("/api/trackers/key", async (SaveTrackerServerRequest request, TrackerServersStore servers, IYouTrack youTrack, CancellationToken cancellationToken) =>
        {
            if (Invalid(request, out var server, out var key) is { } problem)
                return Results.BadRequest(problem);
            if (!servers.Contains(server))
                return Results.NotFound();
            return await CheckAndSaveAsync(server, key, servers, youTrack, cancellationToken);
        });

        app.MapDelete("/api/trackers", (string server, TrackerServersStore servers) =>
            servers.Remove(server) ? Results.NoContent() : Results.NotFound());
    }

    private static TrackerServerProblem? Invalid(SaveTrackerServerRequest request, out string server, out string key)
    {
        server = (request.Server ?? "").Trim().TrimEnd('/');
        key = (request.Key ?? "").Trim();
        if (server.Length == 0)
            return new TrackerServerProblem(EmptyServer);
        if (!Tracker.IsServerAddress(server))
            return new TrackerServerProblem(NotAddress);
        return key.Length == 0 ? new TrackerServerProblem(EmptyKey) : null;
    }

    private static async Task<IResult> CheckAndSaveAsync(
        string server, string key, TrackerServersStore servers, IYouTrack youTrack, CancellationToken cancellationToken)
    {
        var who = await youTrack.WhoAsync(server, key, cancellationToken);
        if (who.Login is not { } login)
            return Results.BadRequest(new TrackerServerProblem(who.Problem ?? TrackerIssues.YouTrackError, who.Detail));
        servers.Save(server, login, key);
        return Results.Ok(new TrackerServer(server, login));
    }
}
