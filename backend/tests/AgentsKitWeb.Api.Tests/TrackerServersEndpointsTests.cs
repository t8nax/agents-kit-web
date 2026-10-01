using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Trackers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Серверы трекеров с владельцами ключей — только чтение: ключи вводятся в окне трекера проекта (ответ оператора на B-285),
/// это держат тесты записи описания.
/// </summary>
public sealed class TrackerServersEndpointsTests : IDisposable
{
    private const string Server = "https://acme.youtrack.cloud";

    private readonly string _root = Directory.CreateTempSubdirectory("akw-trackers-api-").FullName;
    private readonly TestHosts _hosts = new();

    private string TrackersFile => Path.Combine(_root, "trackers.json");

    public void Dispose()
    {
        _hosts.Dispose();
        TestDirs.Delete(_root);
    }

    [Fact]
    public async Task List_NamesOwnerAndEmail_NeverKey()
    {
        var store = new TrackerServersStore(TrackersFile);
        store.Save(Server, "boris.k", "perm:секрет");
        store.Save("https://acme.atlassian.net", "anna@acme.example", "секрет-jira", "anna@acme.example");

        var client = Client();
        var servers = await client.GetFromJsonAsync<List<TrackerServer>>("/api/trackers");
        var body = await client.GetStringAsync("/api/trackers");

        Assert.Equal(
            [new TrackerServer(Server, "boris.k"), new TrackerServer("https://acme.atlassian.net", "anna@acme.example", "anna@acme.example")],
            servers);
        Assert.DoesNotContain("секрет", body);
        Assert.DoesNotContain("\"key\"", body, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Ключи вводятся в окне трекера проекта: отдельно добавить, заменить или удалить сервер API не даёт.</summary>
    [Fact]
    public async Task Writing_IsNotOffered()
    {
        var client = Client();

        using var added = await client.PostAsJsonAsync("/api/trackers", new { server = Server, key = "k" });
        using var replaced = await client.PutAsJsonAsync("/api/trackers/key", new { server = Server, key = "k" });

        Assert.False(added.IsSuccessStatusCode);
        Assert.False(replaced.IsSuccessStatusCode);
        Assert.False(File.Exists(TrackersFile));
    }

    [Fact]
    public async Task BrokenFile_IsNamed()
    {
        File.WriteAllText(TrackersFile, "не json");

        using var list = await Client().GetAsync("/api/trackers");

        Assert.Equal(HttpStatusCode.InternalServerError, list.StatusCode);
        Assert.Equal(new TrackerServerProblem(TrackerServersEndpoints.FileBroken, TrackersFile), await list.Content.ReadFromJsonAsync<TrackerServerProblem>());
        Assert.Equal("не json", File.ReadAllText(TrackersFile));
    }

    /// <summary>Без своей настройки файл серверов лежит рядом с bases.json — у песочницы и тестов он свой.</summary>
    [Fact]
    public async Task Store_LiesBesideBasesFile()
    {
        new TrackerServersStore(Path.Combine(_root, "trackers.json")).Save(Server, "boris.k", "k");

        var servers = await Client(trackersFile: null).GetFromJsonAsync<List<TrackerServer>>("/api/trackers");

        Assert.Equal([new TrackerServer(Server, "boris.k")], servers);
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
        })).CreateClient();
}
