using System.Runtime.InteropServices;

namespace AgentsKitWeb.Api.Voice;

public sealed record VoiceTextResponse(string Text);

public static class VoiceEndpoints
{
    public const int SampleRate = 16000;

    /// <summary>
    /// Кусок речи — от паузы до паузы; минута с запасом покрывает и долгую фразу без вдоха. Длиннее фронт
    /// сам режет на куски, а больший кусок — ошибка клиента, не повод держать память панели.
    /// </summary>
    public const int MaxSeconds = 60;

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

        // Тело — отсчёты float32 little-endian, моно 16 кГц: фронт пишет звук сразу в этом виде,
        // и панели не нужно разбирать форматы звука.
        app.MapPost("/api/voice/recognize", async (
            HttpRequest request, VoiceModel model, ISpeechRecognizer recognizer, CancellationToken cancellationToken) =>
        {
            if (!model.Installed)
                return Results.Conflict();
            using var body = new MemoryStream();
            var limit = MaxSeconds * SampleRate * sizeof(float);
            var buffer = new byte[81920];
            int read;
            while ((read = await request.Body.ReadAsync(buffer, cancellationToken)) > 0)
            {
                if (body.Length + read > limit)
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                body.Write(buffer, 0, read);
            }
            if (body.Length == 0 || body.Length % sizeof(float) != 0)
                return Results.BadRequest();
            var samples = MemoryMarshal.Cast<byte, float>(body.GetBuffer().AsSpan(0, (int)body.Length)).ToArray();
            return Results.Ok(new VoiceTextResponse(await recognizer.RecognizeAsync(samples, cancellationToken)));
        });
    }
}
