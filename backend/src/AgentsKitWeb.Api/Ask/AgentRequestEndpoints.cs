namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Просьбы к агенту, которые панель держит сама. Окно подписывается на ход потоком NDJSON и читает его
/// с начала: закрытое и открытое заново, оно видит ту же работу. Обрыв потока просьбу не трогает — её
/// убирает только явный DELETE, он же останавливает агента.
/// </summary>
public static class AgentRequestEndpoints
{
    public static void MapAgentRequestEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/agent/requests", (AgentRequests requests) => requests.List());

        app.MapGet("/api/agent/{kind}/stream", async (
            string kind, string? id, int? from, AgentRequests requests, HttpContext http) =>
        {
            if (requests.Of(kind) is not { } request)
                return Results.NotFound();
            // Просьба того же вида, но другая: окно ждёт свою и по 404 перечитает список просьб.
            if (id is not null && id != request.Id)
                return Results.NotFound();

            var response = http.Response;
            response.ContentType = "application/x-ndjson; charset=utf-8";
            response.Headers.CacheControl = "no-cache";
            await response.StartAsync(http.RequestAborted);

            var index = Math.Max(0, from ?? 0);
            try
            {
                while (true)
                {
                    var (lines, finished, written) = request.Since(index);
                    // Накопленное уходит одной записью: окно, открытое заново, получает прошлую переписку целиком
                    // и решает по ней, а не по её половине, — ждёт ли в ней предложение (B-228).
                    if (lines.Count > 0)
                        await response.WriteAsync(string.Concat(lines.Select(line => line + "\n")), http.RequestAborted);
                    index += lines.Count;
                    await response.Body.FlushAsync(http.RequestAborted);
                    if (finished)
                        break;
                    await written.WaitAsync(http.RequestAborted);
                }
            }
            catch (OperationCanceledException)
            {
                // Оператор закрыл окно или ушёл со страницы: агент работает дальше, ход копится в просьбе.
            }
            return Results.Empty;
        });

        app.MapDelete("/api/agent/{kind}", (string kind, AgentRequests requests) =>
            requests.Remove(kind) ? Results.NoContent() : Results.NotFound());
    }
}
