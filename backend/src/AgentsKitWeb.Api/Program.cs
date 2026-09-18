using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Usage;
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
{
    var config = services.GetRequiredService<IConfiguration>();
    return new FlowIconsStore(config["FlowIconsFile"] ?? FlowIconsStore.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
});
builder.Services.AddSingleton(services =>
    new AgentSessions(services.GetRequiredService<IConfiguration>()["SessionsDir"] ?? AgentSessions.DefaultDirectory));
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new TaskSessions(config["TaskSessionsFile"] ?? TaskSessions.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(services =>
    new UsageScanner(services.GetRequiredService<IConfiguration>()["ProjectsDir"] ?? UsageScanner.DefaultDirectory,
        services.GetRequiredService<TimeProvider>()));
builder.Services.AddSingleton(services =>
    new ClaudeCredentials(services.GetRequiredService<IConfiguration>()["CredentialsFile"] ?? ClaudeCredentials.DefaultFile));
// Запрос о лимитах идёт к Anthropic, и ждать его дольше нескольких секунд разделу незачем:
// лучше строка «не ответил вовремя», чем раздел, который висит на открытии.
builder.Services.AddHttpClient<ILimits, AnthropicLimits>(client => client.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddSingleton<IEditorWindows, VsCodeWindows>();
builder.Services.AddSingleton<ITerminalWindows, WindowsTerminals>();
builder.Services.AddSingleton(services =>
    new KitLocator(services.GetRequiredService<IConfiguration>()["ClaudeDir"] ?? KitLocator.DefaultClaudeDir));
builder.Services.AddSingleton<IKitChecks, PwshKitChecks>();
builder.Services.AddSingleton<IAgentProcess, AgentProcess>();
builder.Services.AddSingleton<AgentRequests>();
builder.Services.AddSingleton<StartedTasks>();
builder.Services.AddSingleton<HealthMonitor>();
builder.Services.AddHostedService(services => services.GetRequiredService<HealthMonitor>());
// Отработавшую сессию задачи панель гасит сама — решение оператора на B-68.
builder.Services.AddHostedService<FinishedTaskSessions>();
var app = builder.Build();

// Собранный фронт лежит в wwwroot поставленной панели; в разработке его отдаёт Vite, а wwwroot пуст.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.MapGet("/api/workspaces", async (
    BasesStore bases,
    HealthMonitor health,
    AgentSessions sessions,
    TaskSessions tasks,
    StartedTasks started,
    CancellationToken cancellationToken) =>
    // Отметка о только что запущенной задаче ложится последней: ей нужна живая сессия из sessions.Annotate.
    started.Annotate(sessions.Annotate(
        HealthMonitor.Annotate(await WorkspaceCollector.CollectAsync(bases.List(), cancellationToken), health.Snapshot),
        tasks.SessionIn)));

app.MapGet("/api/health", (HealthMonitor health) => health.Snapshot);
app.MapPost("/api/health/check", (HealthMonitor health) =>
{
    health.RequestCheck();
    return Results.Accepted();
});

app.MapAgentRequestEndpoints();
app.MapAskEndpoints();
app.MapBacklogEndpoints();
app.MapBacklogWriteEndpoints();
app.MapBasesEndpoints();
app.MapFlowEndpoints();
app.MapFlowRewriteEndpoints();
app.MapFoldersEndpoints();
app.MapNewWorkspaceEndpoints();
app.MapOperatorEndpoints();
app.MapPerformerDraftEndpoints();
app.MapPerformerSyncEndpoints();
app.MapPerformersEndpoints();
app.MapSessionsEndpoints();
app.MapTaskEndpoints();
app.MapUsageEndpoints();

// Неизвестный /api — ошибка клиента, а не страница фронта; прочие пути — маршруты фронта.
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

public record PingResponse(string Status);

public partial class Program;
