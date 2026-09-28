using AgentsKitWeb.Api.Reports;

namespace AgentsKitWeb.Api.Tests;

public sealed class ReportsStoreTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("akw-reports-").FullName;

    private string File => Path.Combine(_dir, "reports.json");

    private static FlowReport Report(DateTimeOffset built) => new(
        built,
        built,
        "отпечаток",
        [new Requirement("П1", "Проходимость", Priority.High, "Каждый исход куда-то ведёт", "у каждого исхода есть продолжение.")],
        [new ReportFinding("1", ["П1"], "Мерж", [new ReportQuote("Мерж", "Спросить «принято».")], "Некуда идти.", "Добавить возврат.")],
        [new ReportDiscussion("Делить ли мерж", "Мерж", "Один этап.", "Проще проверить.", "Больше отметок.")]);

    [Fact]
    public void Of_UnknownBase_IsEmptyWithScheduleOff()
    {
        var entry = new ReportsStore(File).Of(@"D:\base", ReportsStore.FlowKind);

        Assert.Null(entry.Report);
        Assert.False(entry.Schedule.Enabled);
        Assert.Null(entry.ScheduledAt);
    }

    [Fact]
    public void SavedReportAndSchedule_SurviveNewStore()
    {
        var built = new DateTimeOffset(2026, 9, 28, 9, 0, 0, TimeSpan.FromHours(3));
        var store = new ReportsStore(File);
        store.SaveReport(@"D:\base", ReportsStore.FlowKind, Report(built));
        store.SaveSchedule(@"D:\base", ReportsStore.FlowKind, new ReportSchedule(true, [DayOfWeek.Friday, DayOfWeek.Monday, DayOfWeek.Friday], 9));

        // Новый экземпляр читает файл заново — как панель после перезапуска.
        var entry = new ReportsStore(File).Of(@"d:\BASE\", ReportsStore.FlowKind);

        Assert.Equal(built, entry.Report!.Built);
        Assert.Equal(Priority.High, entry.Report.Requirements[0].Priority);
        Assert.Equal(["П1"], entry.Report.Findings[0].Requirements);
        Assert.Equal("Делить ли мерж", entry.Report.Discussions[0].Title);
        Assert.Equal([DayOfWeek.Monday, DayOfWeek.Friday], entry.Schedule.Days);
        Assert.True(entry.Schedule.Enabled);
    }

    [Fact]
    public void Entries_AreKeptPerBaseAndKind()
    {
        var store = new ReportsStore(File);
        store.SaveSchedule(@"D:\one", ReportsStore.FlowKind, new ReportSchedule(true, [DayOfWeek.Monday], 8));
        store.SaveSchedule(@"D:\two", ReportsStore.FlowKind, new ReportSchedule(true, [DayOfWeek.Sunday], 20));
        store.SaveSchedule(@"D:\one", "other", new ReportSchedule(true, [DayOfWeek.Tuesday], 10));

        Assert.Equal(8, store.Of(@"D:\one", ReportsStore.FlowKind).Schedule.Hour);
        Assert.Equal(20, store.Of(@"D:\two", ReportsStore.FlowKind).Schedule.Hour);
        Assert.Equal(10, store.Of(@"D:\one", "other").Schedule.Hour);
        Assert.Equal(3, store.All().Count);
    }

    [Fact]
    public void MarkChecked_MovesOnlyCheckTime()
    {
        var built = new DateTimeOffset(2026, 9, 26, 12, 30, 0, TimeSpan.Zero);
        var store = new ReportsStore(File);
        store.SaveReport(@"D:\base", ReportsStore.FlowKind, Report(built));

        store.MarkChecked(@"D:\base", ReportsStore.FlowKind, built.AddDays(2));

        var report = store.Of(@"D:\base", ReportsStore.FlowKind).Report!;
        Assert.Equal(built, report.Built);
        Assert.Equal(built.AddDays(2), report.Checked);
    }

    [Fact]
    public void MarkScheduled_IsRemembered()
    {
        var due = new DateTimeOffset(2026, 9, 28, 9, 0, 0, TimeSpan.Zero);
        var store = new ReportsStore(File);

        store.MarkScheduled(@"D:\base", ReportsStore.FlowKind, due);

        Assert.Equal(due, new ReportsStore(File).Of(@"D:\base", ReportsStore.FlowKind).ScheduledAt);
    }

    [Fact]
    public void BrokenFile_ReadsAsEmpty()
    {
        System.IO.File.WriteAllText(File, "{ не json");

        Assert.Null(new ReportsStore(File).Of(@"D:\base", ReportsStore.FlowKind).Report);
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, true)]
    [InlineData(23, true)]
    [InlineData(24, false)]
    public void Schedule_HourMustFitDay(int hour, bool valid) =>
        Assert.Equal(valid, new ReportSchedule(true, [DayOfWeek.Monday], hour).IsValid);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
