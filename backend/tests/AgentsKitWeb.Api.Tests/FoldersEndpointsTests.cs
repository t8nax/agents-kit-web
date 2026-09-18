using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class FoldersEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-folders-").FullName;
    private readonly WebApplicationFactory<Program> _factory;

    public FoldersEndpointsTests()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", Path.Combine(_root, "panel", "bases.json"))]);
            }));
    }

    [Fact]
    public async Task Folders_WithoutPath_ListsReadyDrives()
    {
        var listing = await _factory.CreateClient().GetFromJsonAsync<FolderListing>("/api/folders");

        Assert.NotNull(listing);
        Assert.Null(listing.Path);
        Assert.Contains(listing.Folders, f => string.Equals(f.Path, Path.GetPathRoot(_root), StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Folders_ListsSubfoldersBasesFirstWithoutHiddenAndFiles()
    {
        var parent = Directory.CreateDirectory(Path.Combine(_root, "projects")).FullName;
        Directory.CreateDirectory(Path.Combine(parent, "app"));
        var knowledge = Directory.CreateDirectory(Path.Combine(parent, "zeta-knowledge")).FullName;
        File.WriteAllText(Path.Combine(knowledge, "agents-kit.json"), "{\"workspaces\":[\"D:\\\\a\",\"D:\\\\b\"]}");
        var broken = Directory.CreateDirectory(Path.Combine(parent, "broken-knowledge")).FullName;
        File.WriteAllText(Path.Combine(broken, "agents-kit.json"), "not json");
        var hidden = Directory.CreateDirectory(Path.Combine(parent, ".hidden"));
        hidden.Attributes |= FileAttributes.Hidden;
        File.WriteAllText(Path.Combine(parent, "readme.txt"), "file");

        var listing = await _factory.CreateClient().GetFromJsonAsync<FolderListing>(Url(parent));

        Assert.NotNull(listing);
        Assert.Equal(parent, listing.Path);
        Assert.Equal(_root, listing.Parent);
        Assert.Equal(
            [
                new FolderEntry("broken-knowledge", broken, true, null),
                new FolderEntry("zeta-knowledge", knowledge, true, 2),
                new FolderEntry("app", Path.Combine(parent, "app"), false, null),
            ],
            listing.Folders);
    }

    [Fact]
    public async Task Folders_MarksKitAndListsItWithBases()
    {
        var parent = Directory.CreateDirectory(Path.Combine(_root, "skills")).FullName;
        Directory.CreateDirectory(Path.Combine(parent, "another"));
        var kit = TestKit.Create(Path.Combine(parent, "agents-kit"));

        var listing = await _factory.CreateClient().GetFromJsonAsync<FolderListing>(Url(parent));

        Assert.NotNull(listing);
        Assert.Equal(
            [
                new FolderEntry("agents-kit", kit, false, null, IsKit: true),
                new FolderEntry("another", Path.Combine(parent, "another"), false, null),
            ],
            listing.Folders);
    }

    [Fact]
    public async Task Folders_RelativePath_IsBadRequest()
    {
        var response = await _factory.CreateClient().GetAsync(Url("projects"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new FolderRejectedResponse("not-full-path"), await response.Content.ReadFromJsonAsync<FolderRejectedResponse>());
    }

    [Fact]
    public async Task Folders_MissingPath_IsNotFound()
    {
        var response = await _factory.CreateClient().GetAsync(Url(Path.Combine(_root, "nope")));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private static string Url(string path) => $"/api/folders?path={Uri.EscapeDataString(path)}";

    public void Dispose()
    {
        TestHost.Stop(_factory);
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(dir, FileAttributes.Directory);
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
