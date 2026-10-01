using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Panel;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Reports;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Voice;
using AgentsKitWeb.Api.Workspaces;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(services =>
    new BasesStore(services.GetRequiredService<IConfiguration>()["BasesFile"] ?? BasesStore.DefaultFile));
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new FlowIconsStore(config["FlowIconsFile"] ?? FlowIconsStore.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
});
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new ReportsStore(config["ReportsFile"] ?? ReportsStore.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
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
    new InstalledPanel(services.GetRequiredService<IConfiguration>()["PublishedFile"] ?? InstalledPanel.DefaultFile));
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new PanelChannelStore(config["PanelFile"] ?? PanelChannelStore.FileBeside(config["BasesFile"] ?? BasesStore.DefaultFile));
});
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new PanelUpdateRunner(
        config["UpdateLogFile"] ?? PanelUpdateRunner.FileBeside(config["PublishedFile"] ?? InstalledPanel.DefaultFile),
        config["UpdateScriptsDir"] ?? PanelUpdateRunner.ScriptsInBuild);
});
// GitHub без ключа требует имя клиента и отвечает быстро; карточка не должна висеть на открытии.
builder.Services.AddHttpClient(GitHubReleases.Client, client =>
{
    client.BaseAddress = new Uri("https://api.github.com/");
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("agents-kit-web");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
});
builder.Services.AddSingleton<IPanelReleases, GitHubReleases>();
builder.Services.AddSingleton<IPanelPromotion, GhPromotion>();
builder.Services.AddSingleton<PanelPromotionStarts>();
// Сотни мегабайт идут минутами: модель читается потоком (ResponseHeadersRead), и срок клиента стережёт
// только заголовки — замолчавший до них сервер не держит «Скачивается» вечно; порции — свой срок в VoiceModel.
builder.Services.AddHttpClient(VoiceModel.Client, client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("agents-kit-web");
});
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    return new VoiceModel(
        config["VoiceDir"] ?? VoiceModel.DefaultDirectory,
        config["VoiceModelUrl"] is { } url ? new Uri(url) : VoiceModel.DefaultSource,
        config["VoiceRuntimeUrl"] is { } runtime ? new Uri(runtime) : VoiceModel.DefaultRuntimeSource,
        config["VoiceRuntimeSha512"] ?? VoiceModel.DefaultRuntimeSha512,
        services.GetRequiredService<IHttpClientFactory>());
});
builder.Services.AddSingleton<ISpeechRecognizer, WhisperRecognizer>();
builder.Services.AddSingleton<IEditorWindows, VsCodeWindows>();
builder.Services.AddSingleton<ITerminalWindows, WindowsTerminals>();
builder.Services.AddSingleton(services =>
    new KitLocator(services.GetRequiredService<IConfiguration>()["ClaudeDir"] ?? KitLocator.DefaultClaudeDir));
// Подключения трекера агенту — из настроек Claude Code рядом с тем же профилем, что и кит (AKW-15).
builder.Services.AddSingleton(services =>
    new AgentTrackers(services.GetRequiredService<IConfiguration>()["ClaudeDir"] ?? KitLocator.DefaultClaudeDir));
builder.Services.AddSingleton<IKitChecks, PwshKitChecks>();
builder.Services.AddSingleton<IAgentProcess, AgentProcess>();
builder.Services.AddSingleton<IGitHubIssues, GhIssues>();
builder.Services.AddSingleton(services =>
{
    var config = services.GetRequiredService<IConfiguration>();
    // Свой список баз (песочница, тесты) — свои и серверы трекеров, рядом с ним; у панели оператора — локальный профиль
    return new TrackerServersStore(config["TrackersFile"]
        ?? (config["BasesFile"] is { } basesFile ? TrackerServersStore.FileBeside(basesFile) : TrackerServersStore.DefaultFile));
});
// Сроки запросам к YouTrack ставит сам клиент — у чтения и заведения они разные.
builder.Services.AddHttpClient(YouTrackApi.Client, client =>
{
    client.Timeout = Timeout.InfiniteTimeSpan;
    client.DefaultRequestHeaders.UserAgent.ParseAdd("agents-kit-web");
});
builder.Services.AddSingleton<IYouTrack, YouTrackApi>();
builder.Services.AddSingleton<ProjectTracker>();
builder.Services.AddSingleton<IAgentChat, AgentChat>();
builder.Services.AddSingleton<AgentRequests>();
builder.Services.AddSingleton<AskConversations>();
builder.Services.AddSingleton<IBacklogCheckGate, OpenBacklogCheckGate>();
builder.Services.AddSingleton<BacklogConversations>();
builder.Services.AddSingleton<FlowConversations>();
builder.Services.AddSingleton<FlowReports>();
builder.Services.AddSingleton<TrackerConversations>();
builder.Services.AddSingleton<PerformerConversations>();
builder.Services.AddSingleton<StartedTasks>();
builder.Services.AddSingleton<ResumedSessions>();
builder.Services.AddSingleton<HealthMonitor>();
builder.Services.AddHostedService(services => services.GetRequiredService<HealthMonitor>());
// Отработавшую сессию задачи панель гасит сама — решение оператора на B-68.
builder.Services.AddHostedService<FinishedTaskSessions>();
builder.Services.AddSingleton<ScheduledReports>();
builder.Services.AddHostedService(services => services.GetRequiredService<ScheduledReports>());
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

app.MapGet("/api/health", (HealthMonitor health) => KitBaseMigrate.Annotate(health.Snapshot));
app.MapPost("/api/health/check", (HealthMonitor health) =>
{
    health.RequestCheck();
    return Results.Accepted();
});

app.MapAgentRequestEndpoints();
app.MapAskEndpoints();
app.MapBacklogEndpoints();
app.MapBacklogWriteEndpoints();
app.MapBacklogTrackerEndpoints();
app.MapBaseMigrateEndpoints();
app.MapBasesEndpoints();
app.MapFlowEndpoints();
app.MapFlowRewriteEndpoints();
app.MapFoldersEndpoints();
app.MapNewWorkspaceEndpoints();
app.MapOperatorEndpoints();
app.MapPanelEndpoints();
app.MapPerformerDraftEndpoints();
app.MapPerformersEndpoints();
app.MapRemoveWorkspaceEndpoints();
app.MapReportEndpoints();
app.MapSessionsEndpoints();
app.MapTaskEndpoints();
app.MapTaskRollbackEndpoints();
app.MapTrackerServersEndpoints();
app.MapProjectTrackersEndpoints();
app.MapTrackerRewriteEndpoints();
app.MapVoiceEndpoints();

// Неизвестный /api — ошибка клиента, а не страница фронта; прочие пути — маршруты фронта.
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

public record PingResponse(string Status);

public partial class Program;
