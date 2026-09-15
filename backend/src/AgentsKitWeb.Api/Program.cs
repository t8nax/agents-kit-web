using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(services =>
    new BasesStore(services.GetRequiredService<IConfiguration>()["BasesFile"] ?? BasesStore.DefaultFile));
var app = builder.Build();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.MapGet("/api/workspaces", (BasesStore bases, CancellationToken cancellationToken) =>
    WorkspaceCollector.CollectAsync(bases.List(), cancellationToken));

app.MapBasesEndpoints();
app.MapOperatorEndpoints();

app.Run();

public record PingResponse(string Status);

public partial class Program;
