using System.Diagnostics;
using System.Text.Json;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Сессия агента из реестра: каталог, в котором она идёт, чем запущена и, у фоновой, её короткий id —
/// тот, которым в неё входят из терминала.
/// </summary>
public sealed record AgentSession(string Cwd, int Pid, string? Entrypoint, string? Kind = null, string? JobId = null)
{
    public bool InVsCode => Entrypoint == "claude-vscode";

    /// <summary>Фоновая сессия — та, что живёт своим процессом без окна; войти в неё можно только по JobId.</summary>
    public bool InBackground => Kind == "bg" && !string.IsNullOrEmpty(JobId);
}

/// <summary>
/// Реестр живых сессий агентов — файлы &lt;pid&gt;.json каталога сессий Claude Code.
/// Формат чужой: панель его только читает и на неизвестные поля не опирается.
/// </summary>
public sealed class AgentSessions(string directory, Func<int, bool>? alive = null)
{
    private readonly Func<int, bool> _alive = alive ?? IsAlive;

    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "sessions");

    /// <summary>Живая сессия VS Code в каталоге копии; null — такой сессии нет.</summary>
    public AgentSession? VsCodeIn(string copyPath) => In(copyPath, session => session.InVsCode);

    /// <summary>
    /// Живая фоновая сессия в каталоге копии; null — такой сессии нет. Ту, что запустила панель, панель
    /// у себя не помнит: id берётся отсюда, поэтому переход есть и после её перезапуска.
    /// </summary>
    public AgentSession? BackgroundIn(string copyPath) => In(copyPath, session => session.InBackground);

    /// <summary>Помечает строки таблицы теми копиями, в которых идёт фоновая сессия: в них есть куда перейти.</summary>
    public IReadOnlyList<WorkspaceRow> Annotate(IReadOnlyList<WorkspaceRow> rows) => rows
        .Select(row => row.Error is null && BackgroundIn(row.Path) is not null
            ? row with { BackgroundSession = true }
            : row)
        .ToList();

    private AgentSession? In(string copyPath, Func<AgentSession, bool> wanted)
    {
        var copy = WorkspaceCollector.Normalize(copyPath);
        return All().FirstOrDefault(session =>
            wanted(session) && WorkspaceCollector.Normalize(session.Cwd).Equals(copy, StringComparison.OrdinalIgnoreCase));
    }

    private IEnumerable<AgentSession> All()
    {
        if (!Directory.Exists(directory))
            yield break;

        foreach (var file in Directory.EnumerateFiles(directory, "*.json"))
        {
            // Файл сессии переживает свой процесс, поэтому живость проверяется по pid, а не по наличию файла.
            if (Parse(file) is { } session && _alive(session.Pid))
                yield return session;
        }
    }

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
                cwd.GetString()!, pidValue, Text(root, "entrypoint"), Text(root, "kind"), Text(root, "jobId"));
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

    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
