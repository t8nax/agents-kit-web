using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Копии, в которых панель уже завела сессию задачи, и с чем она её заводила: короткий id сессии и запись
/// бэклога — её номер с заголовком. Память задачи появляется не сразу — агент до неё читает флоу и решения, —
/// и до тех пор о задаче знает только панель. Отметка снимается, когда память появилась или сессия ушла.
/// </summary>
public sealed class StartedTasks
{
    private readonly Dictionary<string, StartedTask> _started = new(StringComparer.OrdinalIgnoreCase);

    public string? SessionIn(string copyPath)
    {
        lock (_started)
            return _started.GetValueOrDefault(Key(copyPath))?.Session;
    }

    public void Add(string copyPath, string session, string task)
    {
        lock (_started)
            _started[Key(copyPath)] = new StartedTask(session, task);
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
    /// </summary>
    public IReadOnlyList<WorkspaceRow> Annotate(IReadOnlyList<WorkspaceRow> rows) => rows
        .Select(row =>
        {
            if (row.Error is not null || SessionIn(row.Path) is null)
                return row;
            if (row.Status != WorkspaceStatus.Free || !row.BackgroundSession)
            {
                Forget(row.Path);
                return row;
            }
            lock (_started)
            {
                return _started.TryGetValue(Key(row.Path), out var started)
                    ? row with { Status = WorkspaceStatus.Starting, Task = started.Task }
                    : row;
            }
        })
        .ToList();

    private static string Key(string copyPath) => WorkspaceCollector.Normalize(copyPath);

    /// <summary>Запущенная задача: id её сессии и запись бэклога — «B-7 Заголовок записи».</summary>
    private sealed record StartedTask(string Session, string Task);
}
