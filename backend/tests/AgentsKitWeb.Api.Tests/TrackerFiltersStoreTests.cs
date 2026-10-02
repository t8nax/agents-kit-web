using AgentsKitWeb.Api.Trackers;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Фильтры задач трекеров хранит панель на этом компьютере, по проектам (B-285).</summary>
public sealed class TrackerFiltersStoreTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-filters-").FullName;

    private string File => Path.Combine(_root, "filters.json");

    public void Dispose() => TestDirs.Delete(_root);

    [Fact]
    public void Of_NothingSet_IsDescribedFilter()
    {
        var store = new TrackerFiltersStore(File);

        Assert.Equal("label:bug", store.Of(@"C:\bases\orders", " label:bug "));
        Assert.Null(store.Of(@"C:\bases\orders", " "));
        Assert.False(System.IO.File.Exists(File));
    }

    /// <summary>Заданный в панели — и пустой тоже — перекрывает строку описания; база сравнивается как путь.</summary>
    [Fact]
    public void Set_OverridesDescribedFilter()
    {
        new TrackerFiltersStore(File).Set(@"C:\bases\orders", " assignee:@me ");
        new TrackerFiltersStore(File).Set(@"C:\bases\crm", "");

        var store = new TrackerFiltersStore(File);
        Assert.Equal("assignee:@me", store.Of(@"c:\BASES\orders\", "label:bug"));
        Assert.Null(store.Of(@"C:\bases\crm", "label:bug"));
    }

    [Fact]
    public void Set_KnownBase_ReplacesItsFilter()
    {
        var store = new TrackerFiltersStore(File);
        store.Set(@"C:\bases\orders", "label:bug");

        store.Set(@"c:\bases\ORDERS", "label:ops");

        Assert.Equal("label:ops", store.Of(@"C:\bases\orders", null));
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(System.IO.File.ReadAllText(File), "orders", System.Text.RegularExpressions.RegexOptions.IgnoreCase));
    }

    [Fact]
    public void Keep_OnlyWhenNothingSet()
    {
        var store = new TrackerFiltersStore(File);

        store.Keep(@"C:\bases\orders", "label:bug");
        store.Keep(@"C:\bases\orders", "label:other");
        store.Keep(@"C:\bases\crm", " ");

        Assert.Equal("label:bug", store.Of(@"C:\bases\orders", null));
        Assert.Equal("label:x", store.Of(@"C:\bases\crm", "label:x"));
    }

    /// <summary>Битый файл: чтение берёт строку описания, запись отказывает и файл не перезаписывает.</summary>
    [Fact]
    public void BrokenFile_IsReadAsDescribedAndNotOverwritten()
    {
        System.IO.File.WriteAllText(File, "не json");
        var store = new TrackerFiltersStore(File);

        Assert.Equal("label:bug", store.Of(@"C:\bases\orders", "label:bug"));
        Assert.Throws<FiltersFileBroken>(() => store.Set(@"C:\bases\orders", "x"));
        Assert.Equal("не json", System.IO.File.ReadAllText(File));
    }
}
