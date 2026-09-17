using System.Diagnostics;
using System.Text.Json;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Сессия агента из реестра: каталог, в котором она идёт, и чем запущена.</summary>
public sealed record AgentSession(string Cwd, int Pid, string? Entrypoint)
{
    public bool InVsCode => Entrypoint == "claude-vscode";
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
    public AgentSession? VsCodeIn(string copyPath)
    {
        var copy = WorkspaceCollector.Normalize(copyPath);
        return All().FirstOrDefault(session =>
            session.InVsCode && WorkspaceCollector.Normalize(session.Cwd).Equals(copy, StringComparison.OrdinalIgnoreCase));
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

            var entrypoint = root.TryGetProperty("entrypoint", out var e) && e.ValueKind == JsonValueKind.String
                ? e.GetString()
                : null;
            return new AgentSession(cwd.GetString()!, pidValue, entrypoint);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Реестр пишет соседний процесс: недочитанный или недописанный файл — не повод ронять опрос.
            return null;
        }
    }

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
