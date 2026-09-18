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

    public string? SessionIn(string copyPath)
    {
        lock (_started)
            return _started.GetValueOrDefault(Key(copyPath))?.Session;
    }

    public void Add(string copyPath, string session, string task)
    {
        lock (_started)
            _started[Key(copyPath)] = new StartedTask(session, task, time.GetUtcNow());
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

    /// <summary>
    /// Запущенная задача: id её сессии, запись бэклога — «B-7 Заголовок записи», — когда панель её
    /// запустила и видела ли она с тех пор свою сессию живой.
    /// </summary>
    private sealed record StartedTask(string Session, string Task, DateTimeOffset Since, bool Seen = false);
}
