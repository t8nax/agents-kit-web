using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class TrackerServersEndpointsTests : IDisposable
{
    private const string Server = "https://acme.youtrack.cloud";

    private readonly string _root = Directory.CreateTempSubdirectory("akw-trackers-api-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly FakeYouTrack _youTrack = new();

    private string TrackersFile => Path.Combine(_root, "trackers.json");

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root);
    }

    [Fact]
    public async Task Add_KeyOwnerNamed_SavesServerWithLogin()
    {
        _youTrack.Who = new YouTrackUser("boris.k");

        using var response = await Client().PostAsJsonAsync("/api/trackers", new { server = Server + "/", key = " perm:ключ " });

        response.EnsureSuccessStatusCode();
        Assert.Equal(new TrackerServer(Server, "boris.k"), await response.Content.ReadFromJsonAsync<TrackerServer>());
        Assert.Equal([(Server, "perm:ключ")], _youTrack.Asked);
        Assert.Equal("perm:ключ", new TrackerServersStore(TrackersFile).KeyOf(Server));
    }

    [Theory]
    [InlineData(TrackerIssues.KeyRejected, null)]
    [InlineData(TrackerIssues.ServerSilent, "истекло время ожидания")]
    public async Task Add_KeyNotConfirmed_IsNotSaved(string problem, string? detail)
    {
        _youTrack.Who = new YouTrackUser(null, problem, detail);

        using var response = await Client().PostAsJsonAsync("/api/trackers", new { server = Server, key = "perm:ключ" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new TrackerServerProblem(problem, detail), await response.Content.ReadFromJsonAsync<TrackerServerProblem>());
        Assert.Empty(new TrackerServersStore(TrackersFile).List());
    }

    [Theory]
    [InlineData("", "perm:k", TrackerServersEndpoints.EmptyServer)]
    [InlineData("acme.youtrack.cloud", "perm:k", TrackerServersEndpoints.NotAddress)]
    [InlineData("https://bot:secret@acme.youtrack.cloud", "perm:k", TrackerServersEndpoints.NotAddress)]
    [InlineData(Server, " ", TrackerServersEndpoints.EmptyKey)]
    public async Task Add_InvalidInput_IsRefusedWithoutAskingServer(string server, string key, string problem)
    {
        using var response = await Client().PostAsJsonAsync("/api/trackers", new { server, key });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(problem, (await response.Content.ReadFromJsonAsync<TrackerServerProblem>())!.Problem);
        Assert.Empty(_youTrack.Asked);
    }

    [Fact]
    public async Task Add_KnownServer_IsConflict()
    {
        new TrackerServersStore(TrackersFile).Save(Server, "boris.k", "old");

        using var response = await Client().PostAsJsonAsync("/api/trackers", new { server = "https://ACME.youtrack.cloud/", key = "new" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("old", new TrackerServersStore(TrackersFile).KeyOf(Server));
    }

    [Fact]
    public async Task ReplaceKey_ChecksNewKeyAndKeepsOldOnRefusal()
    {
        new TrackerServersStore(TrackersFile).Save(Server, "boris.k", "old");
        _youTrack.Who = new YouTrackUser(null, TrackerIssues.KeyRejected);
        var client = Client();

        using var refused = await client.PutAsJsonAsync("/api/trackers/key", new { server = Server, key = "bad" });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("old", new TrackerServersStore(TrackersFile).KeyOf(Server));

        _youTrack.Who = new YouTrackUser("b.kuznetsov");
        using var replaced = await client.PutAsJsonAsync("/api/trackers/key", new { server = Server, key = "new" });
        replaced.EnsureSuccessStatusCode();
        Assert.Equal("new", new TrackerServersStore(TrackersFile).KeyOf(Server));
        Assert.Equal([new TrackerServer(Server, "b.kuznetsov")], new TrackerServersStore(TrackersFile).List());
    }

    [Fact]
    public async Task ReplaceKey_UnknownServer_IsNotFound()
    {
        using var response = await Client().PutAsJsonAsync("/api/trackers/key", new { server = Server, key = "new" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_youTrack.Asked);
    }

    [Fact]
    public async Task List_NeverCarriesKey()
    {
        new TrackerServersStore(TrackersFile).Save(Server, "boris.k", "perm:секрет");

        var body = await Client().GetStringAsync("/api/trackers");

        Assert.Contains("boris.k", body);
        Assert.DoesNotContain("секрет", body);
        Assert.DoesNotContain("key", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Delete_RemovesServerWithKey()
    {
        new TrackerServersStore(TrackersFile).Save(Server, "boris.k", "perm:секрет");
        var client = Client();

        using var deleted = await client.DeleteAsync($"/api/trackers?server={Uri.EscapeDataString(Server)}");
        using var again = await client.DeleteAsync($"/api/trackers?server={Uri.EscapeDataString(Server)}");

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        Assert.Empty(new TrackerServersStore(TrackersFile).List());
    }

    /// <summary>Без своей настройки файл серверов ложится рядом с bases.json — у песочницы и тестов он свой.</summary>
    [Fact]
    public async Task Store_LiesBesideBasesFile()
    {
        _youTrack.Who = new YouTrackUser("boris.k");

        using var response = await Client(trackersFile: null).PostAsJsonAsync("/api/trackers", new { server = Server, key = "k" });

        response.EnsureSuccessStatusCode();
        Assert.True(File.Exists(Path.Combine(_root, "trackers.json")));
    }

    private HttpClient Client(string? trackersFile = "") =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                var settings = new List<KeyValuePair<string, string?>> { new("BasesFile", Path.Combine(_root, "bases.json")) };
                if (trackersFile is not null)
                    settings.Add(new("TrackersFile", TrackersFile));
                config.AddInMemoryCollection(settings);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IYouTrack>();
                services.AddSingleton<IYouTrack>(_youTrack);
            });
        })).CreateClient();
}
