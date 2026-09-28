namespace AgentsKitWeb.Api.Voice;

public static class VoiceEndpoints
{
    public static void MapVoiceEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/voice", (VoiceModel model) => model.Read());

        // Скачивание идёт в фоне: карточка следит за ходом по GET /api/voice.
        app.MapPost("/api/voice/install", (VoiceModel model) =>
            model.Install() ? Results.Accepted() : Results.Conflict());

        app.MapPost("/api/voice/cancel", (VoiceModel model) =>
        {
            model.Cancel();
            return Results.NoContent();
        });

        app.MapDelete("/api/voice", (VoiceModel model) =>
            model.Remove() ? Results.NoContent() : Results.Conflict());
    }
}
