using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class StaticFrontendTests : IDisposable
{
    private const string IndexHtml = "<!doctype html><title>panel</title>";

    private readonly string _root = Directory.CreateTempSubdirectory("akw-static-").FullName;
    private readonly WebApplicationFactory<Program> _factory;

    public StaticFrontendTests()
    {
        var webRoot = Directory.CreateDirectory(Path.Combine(_root, "wwwroot")).FullName;
        File.WriteAllText(Path.Combine(webRoot, "index.html"), IndexHtml);
        Directory.CreateDirectory(Path.Combine(webRoot, "assets"));
        File.WriteAllText(Path.Combine(webRoot, "assets", "app.js"), "console.log('panel')");

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseWebRoot(webRoot);
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", Path.Combine(_root, "bases.json"))]);
            });
        });
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/workspaces/some-copy")]
    public async Task FrontendPath_ReturnsIndexHtml(string path)
    {
        var response = await _factory.CreateClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(IndexHtml, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Asset_IsServedAsFile()
    {
        var response = await _factory.CreateClient().GetAsync("/assets/app.js");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("console.log('panel')", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("/api/unknown")]
    [InlineData("/api/unknown/nested")]
    [InlineData("/assets/missing.js")]
    public async Task UnknownApiOrFile_IsNotFound(string path)
    {
        var response = await _factory.CreateClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task KnownApi_StillWorks()
    {
        var response = await _factory.CreateClient().GetAsync("/api/ping");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
    }

    public void Dispose()
    {
        TestHost.Stop(_factory);
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
