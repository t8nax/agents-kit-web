using AgentsKitWeb.Api.Usage;

namespace AgentsKitWeb.Api.Tests;

public class UsageJournalTests
{
    private const string Answer = """
        {"type":"assistant","timestamp":"2026-09-18T10:00:00.000Z","sessionId":"s1","cwd":"d:\\Projects\\nota","message":{"model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":175,"cache_creation_input_tokens":15324,"cache_read_input_tokens":27000}}}
        """;

    [Fact]
    public void Parse_ReadsTokensModelAndTime()
    {
        var record = UsageJournal.Parse(Answer);

        Assert.NotNull(record);
        Assert.Equal("claude-opus-5", record.Model);
        Assert.Equal(2, record.Input);
        Assert.Equal(175, record.Output);
        Assert.Equal(15324, record.CacheWrite);
        Assert.Equal(27000, record.CacheRead);
        Assert.Equal(15324 + 27000 + 175 + 2, record.Tokens);
        Assert.Equal(new DateTimeOffset(2026, 9, 18, 10, 0, 0, TimeSpan.Zero), record.At);
    }

    [Fact]
    public void Parse_SkipsLinesWithoutUsage()
    {
        Assert.Null(UsageJournal.Parse("""{"type":"user","timestamp":"2026-09-18T10:00:00.000Z","message":{"role":"user"}}"""));
        Assert.Null(UsageJournal.Parse(""));
        Assert.Null(UsageJournal.Parse("   "));
    }

    [Fact]
    public void Parse_SkipsTornLine()
    {
        // Журнал идущей сессии дописывается прямо сейчас, и последняя строка бывает оборвана.
        Assert.Null(UsageJournal.Parse("""{"type":"assistant","message":{"usage":{"input_"""));
    }

    [Fact]
    public void Parse_KeepsRecordWithoutModelName()
    {
        var record = UsageJournal.Parse("""
            {"timestamp":"2026-09-18T10:00:00.000Z","message":{"usage":{"output_tokens":10}}}
            """);

        Assert.NotNull(record);
        Assert.Equal(UsageJournal.UnknownModel, record.Model);
        Assert.Equal(10, record.Tokens);
    }

    [Fact]
    public void Parse_ReadsHourCacheAndPriceModes()
    {
        var record = UsageJournal.Parse("""
            {"timestamp":"2026-09-18T10:00:00.000Z","message":{"model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":10,"cache_creation_input_tokens":300,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":200,"ephemeral_5m_input_tokens":100},"speed":"fast","inference_geo":"us"}}}
            """);

        Assert.NotNull(record);
        Assert.Equal(300, record.CacheWrite);
        Assert.Equal(200, record.CacheWrite1h);
        Assert.True(record.Fast);
        Assert.True(record.UsOnly);
    }

    [Fact]
    public void Parse_WithoutCacheBreakdown_TakesAllCacheWriteAsFiveMinutes()
    {
        var record = UsageJournal.Parse(Answer);

        Assert.NotNull(record);
        Assert.Equal(0, record.CacheWrite1h);
        Assert.False(record.Fast);
        Assert.False(record.UsOnly);
    }

    [Fact]
    public void Parse_NamesTheAnswerByMessageIdOrElseRequestId()
    {
        Assert.Equal("msg_1", UsageJournal.Parse("""
            {"timestamp":"2026-09-18T10:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","usage":{"output_tokens":10}}}
            """)!.Id);
        Assert.Equal("req_1", UsageJournal.Parse("""
            {"timestamp":"2026-09-18T10:00:00.000Z","requestId":"req_1","message":{"usage":{"output_tokens":10}}}
            """)!.Id);
        Assert.Null(UsageJournal.Parse(Answer)!.Id);
    }

    [Fact]
    public void Parse_GeoOtherThanUsGivesNoSurcharge()
    {
        // В живых журналах стоит «not_available» — надбавки за вывод в США у него нет
        var record = UsageJournal.Parse("""
            {"timestamp":"2026-09-18T10:00:00.000Z","message":{"model":"claude-opus-5","usage":{"output_tokens":10,"inference_geo":"not_available","speed":"standard"}}}
            """);

        Assert.NotNull(record);
        Assert.False(record.UsOnly);
        Assert.False(record.Fast);
    }
}

public class UsagePricesTests
{
    [Theory]
    [InlineData("claude-opus-5", "Opus 5")]
    [InlineData("claude-opus-4-8", "Opus 4.8")]
    [InlineData("claude-opus-4-20250514", "Opus 4")]
    [InlineData("claude-sonnet-4-6", "Sonnet 4.6")]
    [InlineData("claude-haiku-4-5-20251001", "Haiku 4.5")]
    [InlineData("claude-fable-5-1", "Fable 5.1")]
    public void Of_KnownVersionGetsItsOwnPrice(string model, string name)
    {
        var pricing = UsagePrices.Of(model);

        Assert.Equal(name, pricing.Price?.Name);
        Assert.False(pricing.ByLine);
    }

    [Theory]
    [InlineData("claude-opus-5-2", "Opus 5")]
    [InlineData("claude-sonnet-6", "Sonnet 5")]
    [InlineData("claude-haiku-5", "Haiku 4.5")]
    public void Of_NewVersionGetsPriceOfItsLine(string model, string name)
    {
        var pricing = UsagePrices.Of(model);

        Assert.Equal(name, pricing.Price?.Name);
        Assert.True(pricing.ByLine);
    }

    [Fact]
    public void Of_ModelOutsideAnyLineHasNoPrice()
    {
        Assert.Null(UsagePrices.Of(UsageJournal.UnknownModel).Price);
        Assert.Null(UsagePrices.Of("что-то-новое").Price);
    }

    [Fact]
    public void Cost_PricesEachKindOfTokens()
    {
        var opus = UsagePrices.Of("claude-opus-5").Price!;
        // По миллиону ввода, вывода и чтения кэша, два миллиона записи кэша — половина на час:
        // 5 + 25 + 0,5 + 6,25 (5 мин, ввод ×1,25) + 10 (час, ввод ×2)
        var record = new UsageRecord(DateTimeOffset.UnixEpoch, "claude-opus-5",
            1_000_000, 1_000_000, 2_000_000, 1_000_000, CacheWrite1h: 1_000_000);

        Assert.Equal(46.75, opus.Cost(record), 5);
        Assert.Equal(93.5, opus.Cost(record with { Fast = true }), 5);
        Assert.Equal(51.425, opus.Cost(record with { UsOnly = true }), 5);
    }

    [Fact]
    public void Cost_FastModeRaisesOnlyModelsThatHaveIt()
    {
        // У Sonnet 5 быстрого режима нет: пометка в журнале цену не меняет — 2 + 10
        var sonnet = UsagePrices.Of("claude-sonnet-5").Price!;
        var record = new UsageRecord(DateTimeOffset.UnixEpoch, "claude-sonnet-5", 1_000_000, 1_000_000, 0, 0, Fast: true);

        Assert.Equal(12, sonnet.Cost(record), 5);
    }

    [Theory]
    [InlineData("claude-3-5-haiku-20241022", "Haiku 3.5", false)]
    [InlineData("claude-3-5-sonnet-20241022", "Sonnet 5", true)]
    public void Of_OldNamingReadsVersionBeforeLine(string model, string name, bool byLine)
    {
        // Дата выпуска после линейки — не номер версии
        var pricing = UsagePrices.Of(model);

        Assert.Equal(name, pricing.Price?.Name);
        Assert.Equal(byLine, pricing.ByLine);
    }
}

public class UsageWeightsTests
{
    [Theory]
    [InlineData("claude-opus-5", 5)]
    [InlineData("claude-opus-4-8", 5)]
    [InlineData("claude-sonnet-5", 1)]
    [InlineData("claude-haiku-4-5-20251001", 0.33)]
    [InlineData("что-то-новое", 1)]
    public void Of_WeighsByModelLine(string model, double weight) =>
        Assert.Equal(weight, UsageWeights.Of(model));
}

public class UsageMathTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 18, 16, 30, 0, TimeSpan.Zero);

    private static UsageBucket Bucket(DateTimeOffset hour, string model, long tokens)
    {
        var bucket = new UsageBucket(hour, model);
        bucket.Add(new UsageRecord(hour, model, 0, tokens, 0, 0));
        return bucket;
    }

    [Fact]
    public void Sum_TakesOnlyBucketsInsideWindow()
    {
        var buckets = new[]
        {
            Bucket(Now.AddHours(-1), "claude-sonnet-5", 1000),
            Bucket(Now.AddHours(-4), "claude-sonnet-5", 500),
            // За пределами пяти часов, но внутри недели
            Bucket(Now.AddHours(-30), "claude-sonnet-5", 300),
            // За пределами недели — не считается вовсе
            Bucket(Now.AddDays(-9), "claude-sonnet-5", 9999),
        };

        var totals = UsageMath.Sum(buckets, Now);

        Assert.Equal(1500, totals.FiveHours.Tokens);
        Assert.Equal(1800, totals.Week.Tokens);
    }

    [Fact]
    public void Sum_SharesModelsByWeightAndAddUpToOne()
    {
        var buckets = new[]
        {
            Bucket(Now.AddHours(-2), "claude-opus-5", 1000),
            Bucket(Now.AddHours(-2), "claude-sonnet-5", 1000),
        };

        var totals = UsageMath.Sum(buckets, Now);

        Assert.Equal(2, totals.Models.Count);
        var opus = totals.Models.Single(model => model.Model == "claude-opus-5");
        var sonnet = totals.Models.Single(model => model.Model == "claude-sonnet-5");
        // Токенов поровну, но вес Opus впятеро больше — доли 5/6 и 1/6
        Assert.Equal(5.0 / 6, opus.Share, 5);
        Assert.Equal(1.0 / 6, sonnet.Share, 5);
        Assert.Equal(1, totals.Models.Sum(model => model.Share), 5);
        // Первой идёт та модель, что съела больше
        Assert.Equal("claude-opus-5", totals.Models[0].Model);
    }

    [Fact]
    public void Sum_LeavesOutModelsThatCostNothing()
    {
        // Claude Code пишет служебные ответы моделью «<synthetic>» и нулём токенов
        var buckets = new[]
        {
            Bucket(Now.AddHours(-2), "claude-sonnet-5", 1000),
            Bucket(Now.AddHours(-2), "<synthetic>", 0),
        };

        var totals = UsageMath.Sum(buckets, Now);

        Assert.Equal("claude-sonnet-5", Assert.Single(totals.Models).Model);
    }

    [Fact]
    public void Sum_CountsDollarsInWindowsAndModels()
    {
        var buckets = new[]
        {
            // Миллион токенов вывода: Opus 5 — $25, Sonnet 5 — $10
            Bucket(Now.AddHours(-1), "claude-opus-5", 1_000_000),
            Bucket(Now.AddHours(-30), "claude-sonnet-5", 1_000_000),
            // Новой версии в прейскуранте нет — по цене линейки, Opus 5
            Bucket(Now.AddHours(-30), "claude-opus-5-2", 1_000_000),
            Bucket(Now.AddHours(-30), UsageJournal.UnknownModel, 1_000_000),
        };

        var totals = UsageMath.Sum(buckets, Now);

        Assert.Equal(25, totals.FiveHours.Cost, 5);
        Assert.Equal(60, totals.Week.Cost, 5);
        Assert.Equal(25, totals.Day.Cost, 5);
        var opus = totals.Models.Single(model => model.Model == "claude-opus-5");
        Assert.Equal(25, opus.Cost!.Value, 5);
        Assert.Null(opus.PricedAs);
        var next = totals.Models.Single(model => model.Model == "claude-opus-5-2");
        Assert.Equal(25, next.Cost!.Value, 5);
        Assert.Equal("Opus 5", next.PricedAs);
        // Цены нет даже у линейки — доллары не выдумываются
        Assert.Null(totals.Models.Single(model => model.Model == UsageJournal.UnknownModel).Cost);
    }

    [Fact]
    public void Sum_CountsLastDay()
    {
        var buckets = new[]
        {
            Bucket(Now.AddHours(-2), "claude-opus-5", 1000),
            // Ровно на краю суток — ещё внутри, как и у других окон
            Bucket(Now.AddHours(-24), "claude-sonnet-5", 200),
            // Вчера раньше края суток — только в неделе
            Bucket(Now.AddHours(-25), "claude-sonnet-5", 4800),
        };

        var totals = UsageMath.Sum(buckets, Now);

        Assert.Equal(Now.AddDays(-1), totals.Day.Since);
        Assert.Equal(1200, totals.Day.Tokens);
    }

    [Fact]
    public void DayPercent_DividesByWeekSinceAnthropicReset()
    {
        // Неделя Anthropic сбросилась сутки назад: весь её расход — эти сутки
        var week = new WindowLimit(14, Now.AddDays(6));
        var buckets = new[]
        {
            Bucket(Now.AddHours(-2), "claude-opus-5", 1000),
            // До сброса — прошлая неделя, в делитель оценки не идёт
            Bucket(Now.AddDays(-3), "claude-sonnet-5", 5000),
        };

        // По скользящей неделе вышло бы 14% × 5000 / 10000 = 7% — вдвое меньше правды
        Assert.Equal(14, UsageMath.DayPercent(buckets, Now, week)!.Value, 5);
    }

    [Fact]
    public void DayPercent_LeavesOutDayHoursBeforeReset()
    {
        // Сброс был пять часов назад: утро этих суток ушло из прошлой недели
        var week = new WindowLimit(10, Now.AddDays(7).AddHours(-5));
        var buckets = new[]
        {
            Bucket(Now.AddHours(-2), "claude-sonnet-5", 1000),
            Bucket(Now.AddHours(-10), "claude-sonnet-5", 3000),
        };

        // Оценка за сутки не больше процента всей недели
        Assert.Equal(10, UsageMath.DayPercent(buckets, Now, week)!.Value, 5);
    }

    [Fact]
    public void DayPercent_NoWeekPercent_GivesNoEstimate()
    {
        var buckets = new[] { Bucket(Now.AddHours(-2), "claude-sonnet-5", 1000) };

        Assert.Null(UsageMath.DayPercent(buckets, Now, null));
        Assert.Equal(0, UsageMath.DayPercent([], Now, new WindowLimit(40, Now.AddDays(2))));
    }

    [Fact]
    public void Sum_EmptyJournalsGiveZeroes()
    {
        var totals = UsageMath.Sum([], Now);

        Assert.Equal(0, totals.FiveHours.Tokens);
        Assert.Equal(0, totals.Week.Tokens);
        Assert.Equal(0, totals.Day.Tokens);
        Assert.Empty(totals.Models);
    }
}

public class UsageScannerTests : IDisposable
{
    private readonly string _directory = Directory.CreateTempSubdirectory("usage-scanner").FullName;
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 9, 18, 16, 30, 0, TimeSpan.Zero));

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private string Journal(string name, params string[] lines)
    {
        var path = Path.Combine(_directory, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, string.Join("\n", lines) + "\n");
        return path;
    }

    private static string Line(DateTimeOffset at, string model, long output) =>
        "{\"type\":\"assistant\",\"timestamp\":\"" + at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") +
        "\",\"message\":{\"model\":\"" + model + "\",\"usage\":{\"output_tokens\":" + output + "}}}";

    [Fact]
    public void Collect_SumsRecordsOfAllProjects()
    {
        Journal("D--Projects-nota/one.jsonl", Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 100));
        Journal("D--Projects-other/two.jsonl", Line(_time.GetUtcNow().AddHours(-2), "claude-opus-5", 200));

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(300, totals.FiveHours.Tokens);
        Assert.Equal(2, totals.Models.Count);
    }

    private static string Part(DateTimeOffset at, string id, long output) =>
        "{\"type\":\"assistant\",\"timestamp\":\"" + at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") +
        "\",\"requestId\":\"req_" + id + "\",\"message\":{\"model\":\"claude-sonnet-5\",\"id\":\"msg_" + id +
        "\",\"usage\":{\"output_tokens\":" + output + "}}}";

    [Fact]
    public void Collect_CountsAnswerWrittenInSeveralLinesOnce()
    {
        // Размышление, текст и вызов инструмента одного ответа — три строки с одним расходом
        var at = _time.GetUtcNow().AddHours(-1);
        Journal("D--Projects-nota/one.jsonl", Part(at, "a", 100), Part(at, "a", 100), Part(at, "a", 100), Part(at, "b", 7));

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(107, totals.FiveHours.Tokens);
    }

    [Fact]
    public void Collect_TakesTheFullestLineOfAnAnswer()
    {
        // Ранняя строка ответа может быть записана недосчитанной — берётся самая полная, где бы она ни стояла
        var at = _time.GetUtcNow().AddHours(-1);
        Journal("D--Projects-nota/one.jsonl", Part(at, "a", 40), Part(at, "a", 100), Part(at, "a", 60));

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(100, totals.FiveHours.Tokens);
    }

    [Fact]
    public void Collect_CountsAnswerCarriedIntoContinuedSessionOnce()
    {
        // Продолженная сессия начинает новый журнал с ответов прошлой
        var at = _time.GetUtcNow().AddHours(-2);
        Journal("D--Projects-nota/first.jsonl", Part(at, "a", 100));
        Journal("D--Projects-nota/second.jsonl", Part(at, "a", 100), Part(_time.GetUtcNow().AddHours(-1), "c", 5));

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(105, totals.FiveHours.Tokens);
    }

    [Fact]
    public void Collect_ReadsSubagentJournals()
    {
        // Журналы субагентов лежат подкаталогом сессии, и их расход идёт из того же лимита.
        Journal("D--Projects-nota/s1/subagents/agent-a1.jsonl", Line(_time.GetUtcNow().AddHours(-1), "claude-haiku-4-5", 50));

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(50, totals.FiveHours.Tokens);
    }

    [Fact]
    public void Collect_SkipsJournalsOlderThanLongestWindow()
    {
        var path = Journal("D--Projects-nota/old.jsonl", Line(_time.GetUtcNow().AddDays(-10), "claude-sonnet-5", 900));
        File.SetLastWriteTimeUtc(path, _time.GetUtcNow().AddDays(-10).UtcDateTime);

        var totals = UsageMath.Sum(new UsageScanner(_directory, _time).Collect(), _time.GetUtcNow());

        Assert.Equal(0, totals.Week.Tokens);
    }

    [Fact]
    public void Collect_ReadsOnlyTheTailOnSecondCall()
    {
        var path = Journal("D--Projects-nota/live.jsonl", Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 100));
        var scanner = new UsageScanner(_directory, _time);
        Assert.Equal(100, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);

        // Прежние строки заменены на мусор: если бы сканер перечитывал файл целиком, счёт бы изменился
        var tail = Line(_time.GetUtcNow().AddMinutes(-10), "claude-sonnet-5", 7);
        var length = new FileInfo(path).Length;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Write))
        {
            stream.Seek(0, SeekOrigin.Begin);
            var noise = new string('x', (int)length - 1) + "\n";
            var bytes = System.Text.Encoding.UTF8.GetBytes(noise);
            stream.Write(bytes, 0, bytes.Length);
        }
        File.AppendAllText(path, tail + "\n");

        Assert.Equal(107, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);
    }

    [Fact]
    public void Collect_RereadsTruncatedJournal()
    {
        var path = Journal("D--Projects-nota/live.jsonl",
            Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 100),
            Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 100));
        var scanner = new UsageScanner(_directory, _time);
        Assert.Equal(200, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);

        File.WriteAllText(path, Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 5) + "\n");

        Assert.Equal(5, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);
    }

    [Fact]
    public void Collect_IgnoresTornLastLineUntilItIsFinished()
    {
        var path = Journal("D--Projects-nota/live.jsonl", Line(_time.GetUtcNow().AddHours(-1), "claude-sonnet-5", 100));
        var torn = Line(_time.GetUtcNow().AddMinutes(-5), "claude-sonnet-5", 42);
        File.AppendAllText(path, torn[..30]);
        var scanner = new UsageScanner(_directory, _time);

        Assert.Equal(100, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);

        File.AppendAllText(path, torn[30..] + "\n");

        Assert.Equal(142, UsageMath.Sum(scanner.Collect(), _time.GetUtcNow()).FiveHours.Tokens);
    }

    [Fact]
    public void Collect_MissingDirectoryGivesNothing()
    {
        var scanner = new UsageScanner(Path.Combine(_directory, "нет-такого"), _time);

        Assert.Empty(scanner.Collect());
    }

    /// <summary>Часы тестов: сканер и счёт окон смотрят на одно и то же «сейчас».</summary>
    private sealed class FakeTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}

public class ClaudeCredentialsTests : IDisposable
{
    private readonly string _directory = Directory.CreateTempSubdirectory("usage-credentials").FullName;

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private string Write(string text)
    {
        var path = Path.Combine(_directory, ".credentials.json");
        File.WriteAllText(path, text);
        return path;
    }

    [Fact]
    public void AccessToken_ReadsTokenOfClaudeAiOauth()
    {
        var file = Write("""{"claudeAiOauth":{"accessToken":"ключ-1","refreshToken":"ключ-2"}}""");

        Assert.Equal("ключ-1", new ClaudeCredentials(file).AccessToken());
        Assert.True(new ClaudeCredentials(file).Present);
    }

    [Fact]
    public void AccessToken_NullWhenThereIsNoFileOrToken()
    {
        Assert.Null(new ClaudeCredentials(Path.Combine(_directory, "нет-такого")).AccessToken());
        Assert.Null(new ClaudeCredentials(Write("{}")).AccessToken());
        Assert.Null(new ClaudeCredentials(Write("""{"claudeAiOauth":{"accessToken":""}}""")).AccessToken());
        Assert.Null(new ClaudeCredentials(Write("не json")).AccessToken());
        Assert.False(new ClaudeCredentials(Write("{}")).Present);
    }
}
