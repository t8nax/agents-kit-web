namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Копии, где панель только что завела сессию задачи взамен умершей (POST /api/tasks/session). В реестр живых
/// сессий заведённая сессия попадает не сразу, и до тех пор повторный запрос не видел бы её и завёл бы вторую:
/// две сессии вели бы одну задачу, а первая перестала бы быть сессией задачи. Отметка держит отказ выдержку.
/// </summary>
public sealed class ResumedSessions(TimeProvider time)
{
    /// <summary>Сколько повторный запрос получает отказ; за это время сессия успевает попасть в реестр.</summary>
    public static readonly TimeSpan Grace = TimeSpan.FromSeconds(15);

    private readonly Dictionary<string, DateTimeOffset> _started = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Отмечает копию и говорит true, если в ней ещё не заводится другая сессия.</summary>
    public bool TryStart(string copyPath)
    {
        var now = time.GetUtcNow();
        lock (_started)
        {
            if (_started.TryGetValue(Key(copyPath), out var at) && now - at < Grace)
                return false;
            _started[Key(copyPath)] = now;
            return true;
        }
    }

    /// <summary>Сессия не завелась: повторить можно сразу.</summary>
    public void Forget(string copyPath)
    {
        lock (_started)
            _started.Remove(Key(copyPath));
    }

    private static string Key(string copyPath) => Workspaces.WorkspaceCollector.Normalize(copyPath);
}
