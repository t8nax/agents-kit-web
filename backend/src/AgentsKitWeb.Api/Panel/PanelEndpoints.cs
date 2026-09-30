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

        // Идёт на GitHub. Панель спрашивает его при открытии «Настроек» и смене канала, а не таймером
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

        // Блок «Выкладка в Стабильный»: есть у поставленной Беты, когда выбран канал «Бета». Идёт на GitHub,
        // пока выкладка идёт, — раз в несколько секунд. GitHub не ответил о выпусках Стабильного — 502, блока нет.
        app.MapGet("/api/panel/stable", async (
            InstalledPanel installed, PanelChannelStore channels, IPanelReleases releases, IPanelPromotion promotion,
            PanelPromotionStarts starts, TimeProvider time, CancellationToken cancellationToken) =>
        {
            if (installed.Read() is not { } published || !Beta(channels, published))
                return Results.NotFound();
            var state = await StableState(published, releases, promotion, starts, time, cancellationToken);
            return state is null ? Results.StatusCode(StatusCodes.Status502BadGateway) : Results.Ok(state);
        });

        // Выкладывается стоящая сборка, а не свежая Бета канала: в Стабильный уходит ровно то, на чём работали.
        app.MapPost("/api/panel/stable", async (
            InstalledPanel installed, PanelChannelStore channels, IPanelReleases releases, IPanelPromotion promotion,
            PanelPromotionStarts starts, TimeProvider time, CancellationToken cancellationToken) =>
        {
            if (installed.Read() is not { } published || !Beta(channels, published))
                return Results.NotFound();
            var state = await StableState(published, releases, promotion, starts, time, cancellationToken);
            if (state is null)
                return Results.StatusCode(StatusCodes.Status502BadGateway);
            if (state.State is not ("ready" or "failed"))
                return Results.Conflict(state);
            if (await promotion.StartAsync(Repository(published), published.Version, published.Sha) is { } refused)
                return Results.Problem(refused, statusCode: StatusCodes.Status502BadGateway);
            starts.Started(published.Version, time.GetUtcNow());
            return Results.Accepted();
        });
    }

    private static bool Beta(PanelChannelStore channels, PublishedPanel published) =>
        published.Channel == PanelChannelStore.Dev && Channel(channels, published) == PanelChannelStore.Dev;

    private static async Task<PanelStableResponse?> StableState(
        PublishedPanel published, IPanelReleases releases, IPanelPromotion promotion, PanelPromotionStarts starts,
        TimeProvider time, CancellationToken cancellationToken)
    {
        var repository = Repository(published);
        if (await releases.ReadAsync(repository, PanelChannelStore.Master, cancellationToken) is not { } stableReleases)
            return null;
        var stable = stableReleases.FirstOrDefault()?.Version;
        var standing = PanelUpdates.Number(published.Version);
        var latest = stable is null ? null : PanelUpdates.Number(stable);
        // Что привезёт стоящая сборка — выпуски Беты между Стабильным и ею; Бета не ответила — перечня нет.
        var arriving = (await releases.ReadAsync(repository, PanelChannelStore.Dev, cancellationToken) ?? [])
            .Where(release => PanelUpdates.Number(release.Version) is { } number
                              && (latest is null || number > latest) && standing is not null && number <= standing)
            .ToList();
        PanelStableResponse Answer(string state) => new(published.Version, stable, state, arriving);

        if (latest is not null && standing is not null && standing <= latest)
            return Answer(standing == latest ? "already" : "older");

        // Выпуски держатся в памяти пару минут, и вышедшую только что сборку раньше видно по запуску выкладки.
        var run = await promotion.LastRunAsync(repository, published.Version, cancellationToken);
        var started = starts.StartedAt(published.Version);
        var appearing = started is { } at && time.GetUtcNow() - at < PanelPromotions.Appearing
                                          && (run is null || run.CreatedAt < at.AddSeconds(-30));
        if (appearing || run is { Running: true })
            return Answer("running");
        if (run is { Succeeded: true })
            return Answer("already");
        if (!await promotion.CanPromoteAsync(repository, cancellationToken))
            return Answer("no-rights");
        return Answer(run is null ? "ready" : "failed");
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
