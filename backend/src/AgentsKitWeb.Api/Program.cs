using AgentsKitWeb.Api.Workspaces;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.MapGet("/api/workspaces", (IConfiguration configuration, CancellationToken cancellationToken) =>
    WorkspaceCollector.CollectAsync(configuration.GetSection("Bases").Get<string[]>() ?? [], cancellationToken));

app.Run();

public record PingResponse(string Status);

public partial class Program;
