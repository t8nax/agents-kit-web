using AgentsKitWeb.Api.Trackers;

namespace AgentsKitWeb.Api.Tests;

public sealed class TrackerServersStoreTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-trackers-").FullName;

    private string File => Path.Combine(_root, "trackers.json");

    public void Dispose() => TestDirs.Delete(_root);

    [Fact]
    public void Save_KeepsKeyReadableOnlyThroughStore()
    {
        var store = new TrackerServersStore(File);

        store.Save("https://acme.youtrack.cloud", "boris.k", "perm:секретный-ключ");

        Assert.Equal([new TrackerServer("https://acme.youtrack.cloud", "boris.k")], store.List());
        Assert.Equal("perm:секретный-ключ", new TrackerServersStore(File).KeyOf("https://acme.youtrack.cloud"));
        // В файле ключа как есть нет: он зашифрован под учётную запись Windows.
        Assert.DoesNotContain("секретный", System.IO.File.ReadAllText(File));
        Assert.DoesNotContain("perm:", System.IO.File.ReadAllText(File));
    }

    /// <summary>У Jira ключ входит с почтой: она хранится у сервера рядом с ключом (B-285).</summary>
    [Fact]
    public void Save_WithEmail_KeepsEmailBesideKey()
    {
        var store = new TrackerServersStore(File);

        store.Save("https://acme.atlassian.net", "anna@acme.example", "ключ", "anna@acme.example");

        Assert.Equal([new TrackerServer("https://acme.atlassian.net", "anna@acme.example", "anna@acme.example")], store.List());
        Assert.Equal((true, "ключ", "anna@acme.example"), new TrackerServersStore(File).Find("https://acme.atlassian.net"));
    }

    /// <summary>Файл, записанный до Jira, почты не несёт — сервер читается, почта пуста.</summary>
    [Fact]
    public void Find_FileWithoutEmail_ReadsKeyWithoutEmail()
    {
        new TrackerServersStore(File).Save("https://acme.youtrack.cloud", "boris.k", "perm:ключ");
        System.IO.File.WriteAllText(File, System.IO.File.ReadAllText(File).Replace(",\n      \"email\": null", "").Replace(",\r\n      \"email\": null", ""));

        Assert.DoesNotContain("email", System.IO.File.ReadAllText(File));
        Assert.Equal((true, "perm:ключ", (string?)null), new TrackerServersStore(File).Find("https://acme.youtrack.cloud"));
    }

    [Fact]
    public void Save_KnownServer_ReplacesKeyInPlace()
    {
        var store = new TrackerServersStore(File);
        store.Save("https://one.youtrack.cloud", "a", "key-1");
        store.Save("https://two.youtrack.cloud", "b", "key-2");

        store.Save("https://ONE.youtrack.cloud/", "a2", "key-3");

        Assert.Equal(
            [new TrackerServer("https://one.youtrack.cloud", "a2"), new TrackerServer("https://two.youtrack.cloud", "b")],
            store.List());
        Assert.Equal("key-3", store.KeyOf("https://one.youtrack.cloud"));
    }

    [Theory]
    [InlineData("https://yt.acme.local/youtrack/")]
    [InlineData("https://YT.acme.local/youtrack")]
    public void KeyOf_SameServerWrittenOtherwise_IsFound(string asked)
    {
        var store = new TrackerServersStore(File);
        store.Save("https://yt.acme.local/youtrack", "b", "key");

        Assert.Equal("key", store.KeyOf(asked));
        Assert.True(store.Contains(asked));
    }

    /// <summary>Битый файл — отказ, и «Добавить» его не перезаписывает: ключи других серверов не пропадают (ревью B-288).</summary>
    [Fact]
    public void BrokenFile_IsRefusedAndNotOverwritten()
    {
        System.IO.File.WriteAllText(File, "{ \"servers\": [ оборвалось");
        var store = new TrackerServersStore(File);

        Assert.Throws<TrackersFileBroken>(() => store.List());
        Assert.Throws<TrackersFileBroken>(() => store.Save("https://yt.acme.local", "b", "key"));
        Assert.Equal("{ \"servers\": [ оборвалось", System.IO.File.ReadAllText(File));
    }

    [Fact]
    public void KeyOf_UnknownServerOrBrokenKey_IsNull()
    {
        System.IO.File.WriteAllText(File, """{ "servers": [ { "server": "https://yt.acme.local", "login": "b", "key": "не-base64" } ] }""");
        var store = new TrackerServersStore(File);

        Assert.Null(store.KeyOf("https://yt.acme.local"));
        Assert.Null(store.KeyOf("https://other.local"));
    }

    [Fact]
    public void Remove_TakesServerWithKey()
    {
        var store = new TrackerServersStore(File);
        store.Save("https://yt.acme.local", "b", "key");

        Assert.True(store.Remove("https://yt.acme.local/"));

        Assert.Empty(store.List());
        Assert.Null(store.KeyOf("https://yt.acme.local"));
        Assert.False(store.Remove("https://yt.acme.local"));
    }

    /// <summary>Ключи панели оператора — в локальном профиле: перемещаемый уехал бы на другие компьютеры (ревью B-288).</summary>
    [Fact]
    public void DefaultFile_IsInLocalProfile()
    {
        Assert.Equal(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "agents-kit-web", "trackers.json"),
            TrackerServersStore.DefaultFile);
        Assert.DoesNotContain(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), TrackerServersStore.DefaultFile);
    }

    [Fact]
    public void List_NoFile_IsEmpty()
    {
        Assert.Empty(new TrackerServersStore(File).List());
    }
}
