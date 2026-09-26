using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Что делает сессия агента в копии. Сессии нет — состояния нет, у строки стоит null.</summary>
public static class SessionState
{
    /// <summary>Идёт запрос: агент работает.</summary>
    public const string Working = "working";

    /// <summary>Сессия держит свой диалог и ждёт оператора в терминале — ответить из панели такому вопросу нельзя.</summary>
    public const string Waiting = "waiting";

    /// <summary>Сессия жива, но ничего не делает и ни о чём не спрашивает.</summary>
    public const string Idle = "idle";

    /// <summary>
    /// Сессия стоит, а её копия ждёт ответа оператора в файле памяти: работа упёрлась в вопрос, а не кончилась.
    /// Состояние считается по копии, поэтому у строки таблицы копий его нет — только в перечне сессий.
    /// </summary>
    public const string AwaitingOperator = "operator";
}

/// <summary>
/// Сессия агента из реестра: каталог, в котором она идёт, чем запущена, что делает и, у фоновой,
/// её короткий id — тот, которым в неё входят из терминала.
/// </summary>
public sealed record AgentSession(
    string Cwd,
    int Pid,
    string? Entrypoint,
    string? Kind = null,
    string? JobId = null,
    string? Status = null,
    long? ProcStart = null,
    string? Name = null,
    long? StartedAt = null)
{
    public bool InVsCode => Entrypoint == "claude-vscode";

    /// <summary>Фоновая сессия — та, что живёт своим процессом без окна; войти в неё можно только по JobId.</summary>
    public bool InBackground => Kind == "bg" && !string.IsNullOrEmpty(JobId);

    /// <summary>
    /// Состояние сессии по её строке status. Claude Code пишет туда waiting, когда держит диалог и ждёт
    /// нажатия, и busy, пока идёт запрос; всё остальное — сессия стоит. Незнакомое значение тоже считается
    /// «стоит»: чужой формат может завести новое, и оно не должно выглядеть работой.
    /// </summary>
    public string State => Status switch
    {
        "waiting" => SessionState.Waiting,
        "busy" => SessionState.Working,
        _ => SessionState.Idle,
    };
}

/// <summary>
/// Реестр живых сессий агентов — файлы &lt;pid&gt;.json каталога сессий Claude Code.
/// Формат чужой: панель его только читает и на неизвестные поля не опирается.
/// </summary>
public sealed class AgentSessions(string directory, Func<int, long?>? processStart = null)
{
    private readonly Func<int, long?> _processStart = processStart ?? StartedAt;

    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "sessions");

    /// <summary>
    /// Живая сессия VS Code в каталоге копии — та из них, которой оператор нужнее; null — такой сессии нет.
    /// </summary>
    public AgentSession? VsCodeIn(string copyPath) => In(copyPath, session => session.InVsCode);

    /// <summary>
    /// Живая фоновая сессия копии с этим id — та, что панель завела под задачу копии; null — id не задан
    /// или сессия уже ушла. Какая сессия ведёт задачу, из чужого списка живых сессий не видно, поэтому
    /// id приходит из памяти панели о запуске (Tasks/TaskSessions).
    /// </summary>
    public AgentSession? BackgroundIn(string copyPath, string? session) =>
        session is null ? null : In(copyPath, s => s.InBackground && s.JobId == session);

    /// <summary>
    /// Дописывает строкам таблицы состояние сессии их задачи и отметку о переходе в неё. И то и другое —
    /// про одну сессию: подпись строки не должна говорить об одной, пока переход ведёт в другую. Строке
    /// с ошибкой дописывать нечего: копии на диске нет или её не прочитали.
    /// Ответ оператора прочтёт только сессия VS Code копии или фоновая сессия задачи — решение оператора
    /// на B-106; нет ни той, ни другой — строка с непрочитанным ответом получает статус Unread.
    /// </summary>
    public IReadOnlyList<WorkspaceRow> Annotate(IReadOnlyList<WorkspaceRow> rows, Func<string, string?> taskSession) => rows
        .Select(row =>
        {
            if (row.Error is not null)
                return row;
            var session = BackgroundIn(row.Path, taskSession(row.Path));
            var vsCode = VsCodeIn(row.Path) is not null;
            var unread = row.AnswerUnread && row.Status == WorkspaceStatus.InWork && session is null && !vsCode;
            return row with
            {
                SessionState = session?.State,
                BackgroundSession = session is not null,
                VsCodeSession = vsCode,
                Status = unread ? WorkspaceStatus.Unread : row.Status,
            };
        })
        .ToList();

    /// <summary>Все живые сессии реестра — перечень раздела «Сессии»; каталог сессии может не быть копией базы.</summary>
    public IReadOnlyList<AgentSession> Live() => All().ToList();

    /// <summary>Живая сессия по её короткому id; null — такой сессии в реестре уже нет.</summary>
    public AgentSession? ByJobId(string jobId) =>
        All().FirstOrDefault(session => session.JobId == jobId);

    /// <summary>
    /// Сессия копии, которой оператор нужнее: ждущая важнее работающей, потому что до ответа работа
    /// стоит, а работающая важнее стоящей без дела. Из равных берётся запущенная позже: старшая — скорее
    /// брошенная с прошлого раза, а времени старта в файле нет — сессия считается старшей. Порядок
    /// файлов реестра ничего не значит, и опираться на него нельзя.
    /// </summary>
    private AgentSession? In(string copyPath, Func<AgentSession, bool> wanted) =>
        LiveIn(copyPath)
            .Where(wanted)
            .OrderByDescending(Urgency)
            .ThenByDescending(session => session.ProcStart ?? 0)
            .FirstOrDefault();

    /// <summary>Насколько сессия нужна оператору прямо сейчас.</summary>
    private static int Urgency(AgentSession session) => session.State switch
    {
        SessionState.Waiting => 2,
        SessionState.Working => 1,
        _ => 0,
    };

    private IEnumerable<AgentSession> LiveIn(string copyPath)
    {
        var copy = WorkspaceCollector.Normalize(copyPath);
        return All().Where(session =>
            WorkspaceCollector.Normalize(session.Cwd).Equals(copy, StringComparison.OrdinalIgnoreCase));
    }

    private IEnumerable<AgentSession> All()
    {
        if (!Directory.Exists(directory))
            yield break;

        foreach (var file in Directory.EnumerateFiles(directory, "*.json"))
        {
            // Файл сессии переживает свой процесс, поэтому живость проверяется по процессу, а не по наличию файла.
            if (Parse(file) is { } session && IsLive(session))
                yield return session;
        }
    }

    /// <summary>
    /// Сессия жива, когда её процесс идёт и стартовал тогда же, когда записано в файле: номер процесса
    /// Windows переиспользует, и без сверки времени старта чужая программа сошла бы за брошенную сессию.
    /// Времени в файле нет — сверять нечем, и остаётся один номер процесса.
    /// </summary>
    private bool IsLive(AgentSession session) =>
        _processStart(session.Pid) is { } started && (session.ProcStart is null || session.ProcStart == started);

    private static AgentSession? Parse(string file)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;
            if (!root.TryGetProperty("cwd", out var cwd) || cwd.ValueKind != JsonValueKind.String)
                return null;
            if (!root.TryGetProperty("pid", out var pid) || !pid.TryGetInt32(out var pidValue))
                return null;

            return new AgentSession(
                cwd.GetString()!,
                pidValue,
                Text(root, "entrypoint"),
                Text(root, "kind"),
                Text(root, "jobId"),
                Text(root, "status"),
                Number(root, "procStart"),
                Text(root, "name"),
                Number(root, "startedAt"));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Реестр пишет соседний процесс: недочитанный или недописанный файл — не повод ронять опрос.
            return null;
        }
    }

    private static string? Text(JsonElement root, string property) =>
        root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>Время старта процесса Claude Code пишет строкой, но числу тоже незачем ломать разбор.</summary>
    private static long? Number(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var value))
            return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
            return number;
        return value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out var parsed)
            ? parsed
            : null;
    }

    /// <summary>Время старта процесса в той же шкале, в какой его пишет реестр; null — процесса нет.</summary>
    private static long? StartedAt(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.HasExited ? null : process.StartTime.ToFileTimeUtc();
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Win32Exception)
        {
            // Процесса нет, он успел уйти между поиском и опросом или его время старта не отдают.
            return null;
        }
    }
}
