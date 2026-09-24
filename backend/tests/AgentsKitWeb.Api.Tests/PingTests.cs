using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PingTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-ping-").FullName;
    private readonly WebApplicationFactory<Program> _factory;

    public PingTests()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root))]);
            }));
    }

    [Fact]
    public async Task Ping_ReturnsPong()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/ping");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<PingResponse>();
        Assert.Equal("pong", body?.Status);
    }

    public void Dispose()
    {
        TestHost.Stop(_factory);
        Directory.Delete(_root, recursive: true);
    }
}
