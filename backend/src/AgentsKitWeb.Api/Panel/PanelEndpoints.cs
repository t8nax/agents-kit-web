namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Что панель знает о самой себе. Installed false — это запуск для разработки: обновлять в нём
/// нечего, и панель говорит об этом вместо кнопки.
/// </summary>
public sealed record PanelResponse(
    string Version,
    bool Installed,
    string? Channel,
    string? Sha,
    DateTimeOffset? BuiltAt);

public static class PanelEndpoints
{
    public static void MapPanelEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/panel", (InstalledPanel installed) =>
        {
            var published = installed.Read();
            return new PanelResponse(
                InstalledPanel.Version,
                published is not null,
                published?.Channel,
                published?.Sha,
                published?.BuiltAt);
        });
    }
}
