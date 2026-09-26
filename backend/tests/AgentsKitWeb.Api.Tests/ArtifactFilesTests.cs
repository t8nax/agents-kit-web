using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class ArtifactFilesTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("akw-artifacts-").FullName;

    [Theory]
    [InlineData("Снимок экрана 2026-09-26 143200.png", "B-1", "B-1-Снимок-экрана-2026-09-26-143200.png")]
    [InlineData("B-1-макет.html", "B-1", "B-1-макет.html")]
    [InlineData("R&D (итог).md", null, "R-D-итог.md")]
    [InlineData("C:\\Users\\op\\лог.txt", null, "лог.txt")]
    [InlineData("  ", "B-2", "B-2-файл")]
    public void FileName_KeepsOnlySafeCharsAndPutsNumberFirst(string name, string? number, string expected) =>
        Assert.Equal(expected, ArtifactFiles.FileName(name, number));

    [Fact]
    public async Task Save_TakesFreeNameAndDoesNotOverwrite()
    {
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        File.WriteAllText(Path.Combine(_base, "artifacts", "B-1-лог.txt"), "чужой");

        var (addresses, rejected) = await ArtifactFiles.SaveAsync(
            _base, [new AttachedFile("лог.txt", Convert.ToBase64String([1])), new AttachedFile("лог.txt", Convert.ToBase64String([2]))], "B-1", CancellationToken.None);

        Assert.Null(rejected);
        Assert.Equal(["artifacts/B-1-лог-2.txt", "artifacts/B-1-лог-3.txt"], addresses);
        Assert.Equal("чужой", File.ReadAllText(Path.Combine(_base, "artifacts", "B-1-лог.txt")));
        Assert.Equal([2], File.ReadAllBytes(Path.Combine(_base, "artifacts", "B-1-лог-3.txt")));
    }

    [Fact]
    public async Task Save_OneRejectedFileLeavesNothing()
    {
        var (addresses, rejected) = await ArtifactFiles.SaveAsync(
            _base, [new AttachedFile("a.txt", Convert.ToBase64String([1])), new AttachedFile("b.txt", "не base64")], null, CancellationToken.None);

        Assert.Null(addresses);
        Assert.Equal(new AttachRejected("b.txt", "unreadable"), rejected);
        Assert.False(Directory.Exists(Path.Combine(_base, "artifacts")));
    }

    [Fact]
    public void Orphans_AreFilesNoMarkdownOfBaseReferences()
    {
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        Directory.CreateDirectory(Path.Combine(_base, "local"));
        foreach (var name in (string[])["a.png", "b.png", "c.png"])
            File.WriteAllText(Path.Combine(_base, "artifacts", name), name);
        File.WriteAllText(Path.Combine(_base, "backlog.md"), "- a: artifacts/a.png\n- b: artifacts/b.png\n");
        File.WriteAllText(Path.Combine(_base, "work", "app.md"), "- b: artifacts/b.png\n");
        File.WriteAllText(Path.Combine(_base, "local", "note.md"), "- c: artifacts/c.png\n");

        var orphans = ArtifactFiles.Orphans(
            _base,
            ["artifacts/a.png", "artifacts/b.png", "artifacts/c.png", "artifacts/нет.png", "https://claude.ai/artifact/X"],
            new Dictionary<string, string> { ["backlog.md"] = "" });

        Assert.Equal(["artifacts/a.png", "artifacts/c.png"], orphans);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_base, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
