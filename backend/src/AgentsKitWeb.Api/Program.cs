using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(services =>
    new BasesStore(services.GetRequiredService<IConfiguration>()["BasesFile"] ?? BasesStore.DefaultFile));
builder.Services.AddSingleton(services =>
    new AgentSessions(services.GetRequiredService<IConfiguration>()["SessionsDir"] ?? AgentSessions.DefaultDirectory));
builder.Services.AddSingleton<IEditorWindows, VsCodeWindows>();
var app = builder.Build();

// Собранный фронт лежит в wwwroot поставленной панели; в разработке его отдаёт Vite, а wwwroot пуст.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.MapGet("/api/workspaces", (BasesStore bases, CancellationToken cancellationToken) =>
    WorkspaceCollector.CollectAsync(bases.List(), cancellationToken));

app.MapBacklogEndpoints();
app.MapBasesEndpoints();
app.MapFoldersEndpoints();
app.MapOperatorEndpoints();

// Неизвестный /api — ошибка клиента, а не страница фронта; прочие пути — маршруты фронта.
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

public record PingResponse(string Status);

public partial class Program;
