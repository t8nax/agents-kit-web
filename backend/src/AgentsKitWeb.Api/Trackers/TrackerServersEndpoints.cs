namespace AgentsKitWeb.Api.Trackers;

/// <summary>Отказ прочитать ключи к серверам трекеров: Problem — код причины, Detail — путь файла.</summary>
public sealed record TrackerServerProblem(string Problem, string? Detail = null);

public static class TrackerServersEndpoints
{
    public const string FileBroken = "file-broken";

    /// <summary>
    /// Серверы трекеров с владельцами ключей — для строки ключа в подробностях проекта раздела «Трекеры» и полей окна
    /// трекера. Вводятся и заменяются ключи в окне трекера проекта вместе с описанием, а не отдельным списком
    /// (ответ оператора на B-285), поэтому здесь только чтение.
    /// </summary>
    public static void MapTrackerServersEndpoints(this IEndpointRouteBuilder app)
    {
        // Битый trackers.json — отказ с его путём, а не пустой список: его не перезаписать молча (ревью B-288)
        app.MapGet("/api/trackers", (TrackerServersStore servers) =>
        {
            try
            {
                return Results.Ok(servers.List());
            }
            catch (TrackersFileBroken broken)
            {
                return Results.Json(new TrackerServerProblem(FileBroken, broken.File), statusCode: StatusCodes.Status500InternalServerError);
            }
        });
    }
}
