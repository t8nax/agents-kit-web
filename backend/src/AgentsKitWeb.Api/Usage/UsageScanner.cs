namespace AgentsKitWeb.Api.Usage;

/// <summary>
/// Сколько израсходовано одной моделью за один час — в эти корзины складываются записи журналов.
/// Доллары считаются при сложении: цена ответа зависит от его режима, а в корзине режима уже нет.
/// </summary>
public sealed record UsageBucket(DateTimeOffset Hour, string Model)
{
    private readonly UsagePrice? _price = UsagePrices.Of(Model).Price;

    public double Cost { get; private set; }
    public long Input { get; private set; }
    public long Output { get; private set; }
    public long CacheWrite { get; private set; }
    public long CacheRead { get; private set; }

    public long Tokens => Input + Output + CacheWrite + CacheRead;

    public void Add(UsageRecord record)
    {
        Input += record.Input;
        Output += record.Output;
        CacheWrite += record.CacheWrite;
        CacheRead += record.CacheRead;
        Cost += _price?.Cost(record) ?? 0;
    }
}

/// <summary>
/// Расход по журналам Claude Code: обходит каталог его сессий и складывает записи в часовые корзины.
/// Журналов на диске сотни мегабайт, поэтому сканер читает как можно меньше: файлы, не менявшиеся
/// дольше самого длинного окна, не открываются вовсе, а открытые дочитываются с прошлой позиции.
/// </summary>
public sealed class UsageScanner(string directory, TimeProvider? time = null)
{
    /// <summary>Самое длинное окно панели: старше него записи не нужны, и файлы старше — тоже.</summary>
    public static readonly TimeSpan LongestWindow = TimeSpan.FromDays(7);

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly Dictionary<string, FileProgress> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _lock = new();

    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "projects");

    /// <summary>Часовые корзины за последнее окно. Каталога нет — пустой список, а не ошибка.</summary>
    public IReadOnlyList<UsageBucket> Collect()
    {
        var since = _time.GetUtcNow() - LongestWindow;
        lock (_lock)
        {
            Scan(since);
            var records = _files.Values
                .SelectMany(progress => progress.Records)
                .Where(record => Hour(record) >= since.AddHours(-1));

            var buckets = new Dictionary<(DateTimeOffset Hour, string Model), UsageBucket>();
            foreach (var record in Once(records))
            {
                var key = (Hour(record), record.Model);
                if (!buckets.TryGetValue(key, out var bucket))
                    buckets[key] = bucket = new UsageBucket(key.Item1, record.Model);
                bucket.Add(record);
            }

            return buckets.Values.ToList();
        }
    }

    /// <summary>
    /// Каждый ответ — один раз. Claude Code пишет ответ строкой на каждую его часть, все с одним расходом,
    /// а продолженная сессия переносит прошлые ответы в новый журнал: без этого расход завышен в разы.
    /// Из строк одного ответа берётся самая полная — на случай, если ранняя записана недосчитанной.
    /// </summary>
    private static IEnumerable<UsageRecord> Once(IEnumerable<UsageRecord> records)
    {
        var byId = new Dictionary<string, UsageRecord>();
        foreach (var record in records)
        {
            if (record.Id is null)
                yield return record;
            else if (!byId.TryGetValue(record.Id, out var known) || record.Tokens > known.Tokens)
                byId[record.Id] = record;
        }

        foreach (var record in byId.Values)
            yield return record;
    }

    private static DateTimeOffset Hour(UsageRecord record) =>
        new DateTimeOffset(record.At.UtcDateTime.Date, TimeSpan.Zero).AddHours(record.At.UtcDateTime.Hour);

    private void Scan(DateTimeOffset since)
    {
        if (!Directory.Exists(directory))
        {
            _files.Clear();
            return;
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.EnumerateFiles(directory, "*.jsonl", SearchOption.AllDirectories))
        {
            FileInfo file;
            try
            {
                file = new FileInfo(path);
                // Журнал, в который неделю не писали, целиком старше самого длинного окна.
                if (file.LastWriteTimeUtc < since.UtcDateTime)
                    continue;
            }
            catch (IOException)
            {
                continue;
            }

            seen.Add(path);
            var progress = _files.TryGetValue(path, out var known) ? known : _files[path] = new FileProgress();
            // Файл усечён или переписан — прочитанное о нём больше не верно.
            if (file.Length < progress.Position)
                progress.Reset();

            if (file.Length > progress.Position)
                Read(path, progress);

            progress.Forget(since);
        }

        foreach (var gone in _files.Keys.Where(path => !seen.Contains(path)).ToList())
            _files.Remove(gone);
    }

    /// <summary>
    /// Дочитывает файл с прошлой позиции. Незавершённая последняя строка не считается и позицию
    /// не двигает: журнал пишется прямо сейчас, и её конец приедет следующим чтением.
    /// </summary>
    private static void Read(string path, FileProgress progress)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            stream.Seek(progress.Position, SeekOrigin.Begin);

            var buffer = new byte[64 * 1024];
            var line = new MemoryStream();
            var position = progress.Position;
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (var i = 0; i < read; i++)
                {
                    if (buffer[i] != (byte)'\n')
                    {
                        line.WriteByte(buffer[i]);
                        continue;
                    }

                    position += line.Length + 1;
                    progress.Take(System.Text.Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length));
                    line.SetLength(0);
                }
            }

            progress.Position = position;
        }
        catch (IOException)
        {
            // Файл занят или исчез между перечислением и чтением — дочитается следующим опросом.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// До какого места прочитан журнал и какие ответы в нём найдены. Хранятся ответы, а не суммы:
    /// повтор одного ответа виден только при сборе по всем журналам сразу.
    /// </summary>
    private sealed class FileProgress
    {
        public long Position { get; set; }

        public List<UsageRecord> Records { get; } = [];

        public void Reset()
        {
            Position = 0;
            Records.Clear();
        }

        public void Take(string line)
        {
            if (UsageJournal.Parse(line) is { } record)
                Records.Add(record);
        }

        /// <summary>Ответы старше окна держать незачем: панель их больше не покажет.</summary>
        public void Forget(DateTimeOffset since) =>
            Records.RemoveAll(record => Hour(record) < since.AddHours(-1));
    }
}
