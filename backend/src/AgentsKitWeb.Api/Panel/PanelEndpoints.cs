namespace AgentsKitWeb.Api.Panel;

/// <summary>Чем собрана стоящая панель — по файлу, который оставила постановка.</summary>
public sealed record PanelBuildResponse(string Channel, string Sha, string Version, DateTimeOffset BuiltAt);

/// <summary>
/// Что панель знает о самой себе. Installed false — это запуск для разработки: обновлять в нём
/// нечего, и панель говорит об этом вместо кнопки. Channel — выбранный канал, а не тот,
/// которым собрана стоящая панель: из него придёт следующее обновление.
/// </summary>
public sealed record PanelResponse(string Version, bool Installed, string Channel, PanelBuildResponse? Published);

public sealed record PanelChannelRequest(string? Channel);

public static class PanelEndpoints
{
    public static void MapPanelEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/panel", (InstalledPanel installed, PanelChannelStore channels) =>
        {
            var published = installed.Read();
            return new PanelResponse(
                InstalledPanel.Version,
                published is not null,
                Channel(channels, published),
                published is null
                    ? null
                    : new PanelBuildResponse(published.Channel, published.Sha, published.Version, published.BuiltAt));
        });

        app.MapPut("/api/panel/channel", (PanelChannelRequest request, PanelChannelStore channels) =>
        {
            if (!PanelChannelStore.Known(request.Channel))
                return Results.BadRequest();
            channels.Write(request.Channel!);
            return Results.NoContent();
        });

        // Идёт на GitHub. Панель спрашивает его по кнопке и при открытии «Настроек», а не таймером
        // таблицы копий. GitHub не ответил — 502: сравнить сейчас не с чем, и кнопки нет.
        app.MapGet("/api/panel/updates", async (
            InstalledPanel installed, PanelChannelStore channels, IPanelReleases releases,
            CancellationToken cancellationToken) =>
        {
            if (installed.Read() is not { } published)
                return Results.NotFound();
            var channel = await releases.ReadAsync(Repository(published), Channel(channels, published), cancellationToken);
            return channel is null
                ? Results.StatusCode(StatusCodes.Status502BadGateway)
                : Results.Ok(PanelUpdates.Newer(channel, published.Version));
        });

        app.MapGet("/api/panel/update", (PanelUpdateRunner updates) => updates.Read());

        app.MapPost("/api/panel/update", async (
            InstalledPanel installed, PanelChannelStore channels, IPanelReleases releases, PanelUpdateRunner updates,
            CancellationToken cancellationToken) =>
        {
            if (installed.Read() is not { } published)
                return Results.NotFound();
            var channel = Channel(channels, published);
            var repository = Repository(published);
            // Ставится самый свежий выпуск канала — тот, что карточка показала оператору.
            var latest = (await releases.ReadAsync(repository, channel, cancellationToken))?.FirstOrDefault();
            if (latest is null)
                return Results.StatusCode(StatusCodes.Status502BadGateway);
            // Уже идёт: панель не запускает вторую подмену того же каталога.
            return updates.Start(published, channel, repository, latest)
                ? Results.Accepted()
                : Results.Conflict();
        });
    }

    /// <summary>
    /// Выбора ещё не было — канал берётся у стоящей панели, а собранной мимо каналов (ветка задачи
    /// на приёмке) достаётся master: обновление должно возвращать панель в канал, а не в ветку.
    /// </summary>
    private static string Channel(PanelChannelStore channels, PublishedPanel? published) =>
        channels.Read()
        ?? (PanelChannelStore.Known(published?.Channel) ? published!.Channel : PanelChannelStore.Master);

    private static string Repository(PublishedPanel published) =>
        string.IsNullOrWhiteSpace(published.Releases) ? PanelUpdates.DefaultRepository : published.Releases;
}
