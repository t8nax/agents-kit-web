var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/api/ping", () => new PingResponse("pong"));

app.Run();

public record PingResponse(string Status);

public partial class Program;
