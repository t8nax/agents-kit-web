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
            return _files.Values
                .SelectMany(progress => progress.Buckets.Values)
                .Where(bucket => bucket.Hour >= since.AddHours(-1))
                .ToList();
        }
    }

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

    /// <summary>До какого места прочитан журнал и что в нём насчитано.</summary>
    private sealed class FileProgress
    {
        public long Position { get; set; }

        public Dictionary<(DateTimeOffset Hour, string Model), UsageBucket> Buckets { get; } = [];

        public void Reset()
        {
            Position = 0;
            Buckets.Clear();
        }

        public void Take(string line)
        {
            var record = UsageJournal.Parse(line);
            if (record is null)
                return;

            var hour = new DateTimeOffset(record.At.UtcDateTime.Date, TimeSpan.Zero).AddHours(record.At.UtcDateTime.Hour);
            var key = (hour, record.Model);
            if (!Buckets.TryGetValue(key, out var bucket))
                Buckets[key] = bucket = new UsageBucket(hour, record.Model);
            bucket.Add(record);
        }

        /// <summary>Корзины старше окна держать незачем: панель их больше не покажет.</summary>
        public void Forget(DateTimeOffset since)
        {
            foreach (var key in Buckets.Where(pair => pair.Value.Hour < since.AddHours(-1)).Select(pair => pair.Key).ToList())
                Buckets.Remove(key);
        }
    }
}
