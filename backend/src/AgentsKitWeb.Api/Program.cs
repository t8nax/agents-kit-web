using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Workspaces;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(services =>
    new BasesStore(services.GetRequiredService<IConfiguration>()["BasesFile"] ?? BasesStore.DefaultFile));
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new PresetsStore(config["PresetsFile"] ?? PresetsStore.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
});
builder.Services.AddSingleton(services =>
    new AgentSessions(services.GetRequiredService<IConfiguration>()["SessionsDir"] ?? AgentSessions.DefaultDirectory));
builder.Services.AddSingleton<IEditorWindows, VsCodeWindows>();
builder.Services.AddSingleton(services =>
    new KitLocator(services.GetRequiredService<IConfiguration>()["ClaudeDir"] ?? KitLocator.DefaultClaudeDir));
builder.Services.AddSingleton<IKitChecks, PwshKitChecks>();
builder.Services.AddSingleton<IAgentProcess, AgentProcess>();
builder.Services.AddSingleton<HealthMonitor>();
builder.Services.AddHostedService(services => services.GetRequiredService<HealthMonitor>());
var app = builder.Build();

// Собранный фронт лежит в wwwroot поставленной панели; в разработке его отдаёт Vite, а wwwroot пуст.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.MapGet("/api/workspaces", async (BasesStore bases, HealthMonitor health, CancellationToken cancellationToken) =>
    HealthMonitor.Annotate(await WorkspaceCollector.CollectAsync(bases.List(), cancellationToken), health.Snapshot));

app.MapGet("/api/health", (HealthMonitor health) => health.Snapshot);
app.MapPost("/api/health/check", (HealthMonitor health) =>
{
    health.RequestCheck();
    return Results.Accepted();
});

app.MapAskEndpoints();
app.MapBacklogEndpoints();
app.MapBacklogWriteEndpoints();
app.MapBasesEndpoints();
app.MapFlowEndpoints();
app.MapFoldersEndpoints();
app.MapNewWorkspaceEndpoints();
app.MapOperatorEndpoints();

// Неизвестный /api — ошибка клиента, а не страница фронта; прочие пути — маршруты фронта.
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

public record PingResponse(string Status);

public partial class Program;
