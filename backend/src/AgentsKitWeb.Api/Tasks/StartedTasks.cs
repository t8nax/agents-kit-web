using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Копии, в которых панель уже завела сессию задачи, и с чем она её заводила: короткий id сессии и запись
/// бэклога — её номер с заголовком. Память задачи появляется не сразу — агент до неё читает флоу и решения, —
/// и до тех пор о задаче знает только панель. Отметка снимается, когда память появилась или сессия ушла.
/// </summary>
public sealed class StartedTasks(TimeProvider time)
{
    /// <summary>
    /// Сколько отметка держится, пока панель ещё не видела свою сессию живой. В реестр живых сессий
    /// заведённая сессия попадает не одновременно с ответом запуска, а спустя десятые доли секунды, и
    /// первый опрос таблицы успевает пройти раньше: без этой льготы отметка стиралась бы сразу после
    /// запуска и копия числилась бы свободной. Запас взят на медленную машину, а не на ожидание.
    /// </summary>
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(10);

    private readonly Dictionary<string, StartedTask> _started = new(StringComparer.OrdinalIgnoreCase);

    // Задачи, чью сессию панель заводит прямо сейчас, — копия, куда она уходит, по базе и номеру задачи.
    private readonly Dictionary<string, string> _claimed = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Берёт задачу базы под запуск в копию: `claude --bg` идёт секунды, и повтор той же задачи в другую копию
    /// за это время прошёл бы любую проверку по строкам копий — две сессии повели бы одну задачу (B-89).
    /// Задачу уже заводят — копия, куда её заводят; взята сейчас — null, и её снимает <see cref="Release"/>.
    /// </summary>
    public string? Claim(string basePath, string number, string copyPath)
    {
        lock (_started)
        {
            if (_claimed.TryGetValue(ClaimKey(basePath, number), out var holder))
                return holder;
            _claimed[ClaimKey(basePath, number)] = copyPath;
            return null;
        }
    }

    public void Release(string basePath, string number)
    {
        lock (_started)
            _claimed.Remove(ClaimKey(basePath, number));
    }

    public string? SessionIn(string copyPath)
    {
        lock (_started)
            return _started.GetValueOrDefault(Key(copyPath))?.Session;
    }

    /// <summary>Задача, которую панель запустила в копии, — «B-7 Заголовок записи»; не запускала — null.</summary>
    public string? TaskIn(string copyPath)
    {
        lock (_started)
            return _started.GetValueOrDefault(Key(copyPath))?.Task;
    }

    public void Add(string copyPath, string session, string task, string? basePath = null)
    {
        lock (_started)
            _started[Key(copyPath)] = new StartedTask(session, task, time.GetUtcNow(), Base: basePath);
    }

    /// <summary>
    /// Задачи базы, которые панель запускает или запустила и памяти у которых ещё нет: копия и задача — номер или
    /// «номер заголовок». По ним описание трекера не удаляется, пока задача из него только заводится (ревью B-293).
    /// </summary>
    public IReadOnlyList<(string Copy, string Task)> OfBase(string basePath)
    {
        var prefix = WorkspaceCollector.Normalize(basePath) + "|";
        lock (_started)
            return _claimed.Where(c => c.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                .Select(c => (c.Value, c.Key[prefix.Length..]))
                .Concat(_started.Where(s => s.Value.Base is { } b && WorkspaceCollector.Normalize(b).Equals(WorkspaceCollector.Normalize(basePath), StringComparison.OrdinalIgnoreCase))
                    .Select(s => (s.Key, s.Value.Task)))
                .ToList();
    }

    public void Forget(string copyPath)
    {
        lock (_started)
            _started.Remove(Key(copyPath));
    }

    /// <summary>
    /// Дописывает копиям, где панель только что запустила задачу, её номер с заголовком и статус
    /// «запускается»: памяти задачи ещё нет, а копия уже занята, и вторую задачу в неё не запустить.
    ///
    /// Отметка держится, пока жива запущенная сессия: живость строка уже несёт в BackgroundSession —
    /// это та самая сессия, которую панель завела под задачу. Ушла она, не заведя памяти, — копия снова
    /// свободна; появилась память — строка живёт по ней, и отметка больше не нужна.
    ///
    /// Пока сессию ни разу не видели живой, отсутствие её в реестре ничего не значит: она туда ещё не
    /// попала. Такая отметка держится льготу и снимается, только если сессия за неё так и не появилась.
    /// </summary>
    public IReadOnlyList<WorkspaceRow> Annotate(IReadOnlyList<WorkspaceRow> rows) => rows
        .Select(row =>
        {
            if (row.Error is not null)
                return row;
            lock (_started)
            {
                var key = Key(row.Path);
                if (!_started.TryGetValue(key, out var started))
                    return row;
                if (row.Status != WorkspaceStatus.Free)
                {
                    _started.Remove(key);
                    return row;
                }
                if (row.BackgroundSession)
                {
                    // Сессия в реестре: дальше её уход снимает отметку сразу, льгота больше не нужна.
                    _started[key] = started with { Seen = true };
                }
                else if (started.Seen || time.GetUtcNow() - started.Since >= Grace)
                {
                    _started.Remove(key);
                    return row;
                }
                return row with { Status = WorkspaceStatus.Starting, Task = started.Task };
            }
        })
        .ToList();

    private static string Key(string copyPath) => WorkspaceCollector.Normalize(copyPath);

    private static string ClaimKey(string basePath, string number) => $"{WorkspaceCollector.Normalize(basePath)}|{number}";

    /// <summary>
    /// Запущенная задача: id её сессии, запись бэклога — «B-7 Заголовок записи», — когда панель её
    /// запустила, видела ли она с тех пор свою сессию живой и в какой базе задача.
    /// </summary>
    private sealed record StartedTask(string Session, string Task, DateTimeOffset Since, bool Seen = false, string? Base = null);
}
