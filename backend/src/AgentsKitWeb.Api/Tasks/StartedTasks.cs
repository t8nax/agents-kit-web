namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Копии, в которых панель уже завела сессию задачи. Память задачи появляется не сразу — агент до неё читает
/// флоу и решения, — и до тех пор копия числится свободной: без этой отметки панель завела бы вторую сессию
/// поверх первой. Отметка снимается, когда копия перестала быть свободной или сессия не завелась.
/// </summary>
public sealed class StartedTasks
{
    private readonly Dictionary<string, string> _sessions = new(StringComparer.OrdinalIgnoreCase);

    public string? SessionIn(string copyPath)
    {
        lock (_sessions)
            return _sessions.GetValueOrDefault(Key(copyPath));
    }

    public void Add(string copyPath, string session)
    {
        lock (_sessions)
            _sessions[Key(copyPath)] = session;
    }

    public void Forget(string copyPath)
    {
        lock (_sessions)
            _sessions.Remove(Key(copyPath));
    }

    private static string Key(string copyPath) => Workspaces.WorkspaceCollector.Normalize(copyPath);
}
