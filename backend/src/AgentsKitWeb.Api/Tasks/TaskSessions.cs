using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Сессии задач, заведённые панелью: копия и короткий id её сессии. Живой список сессий Claude Code
/// про задачу не говорит ничего, поэтому «ту самую» сессию копии панель знает только по своему запуску
/// — решение оператора на B-58. Запись лежит в файле профиля, а не в памяти процесса: сессия переживает
/// панель, и переход в неё есть и после перезапуска.
/// </summary>
public sealed class TaskSessions(string file)
{
    private readonly Lock _lock = new();

    /// <summary>task-sessions.json в каталоге файла настроек, как остальные списки панели.</summary>
    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "task-sessions.json");

    /// <summary>Короткий id сессии, которую панель завела в этой копии; null — панель тут задачу не запускала.</summary>
    public string? SessionIn(string copyPath)
    {
        lock (_lock)
            return Read().FirstOrDefault(s => Same(s.Copy, copyPath))?.Session;
    }

    /// <summary>Запоминает сессию задачи копии; прежняя запись копии заменяется — задача в копии одна.</summary>
    public void Remember(string copyPath, string session)
    {
        var copy = WorkspaceCollector.Normalize(copyPath);
        lock (_lock)
        {
            var left = Read().Where(s => !Same(s.Copy, copy)).ToList();
            Write([.. left, new TaskSession(copy, session)]);
        }
    }

    private static bool Same(string a, string b) =>
        string.Equals(WorkspaceCollector.Normalize(a), WorkspaceCollector.Normalize(b), StringComparison.OrdinalIgnoreCase);

    private List<TaskSession> Read()
    {
        if (!File.Exists(file))
            return [];
        try
        {
            using var stream = File.OpenRead(file);
            return JsonSerializer.Deserialize<TaskSessionsFile>(stream, JsonOptions)?.Sessions ?? [];
        }
        catch (Exception exception) when (exception is IOException or JsonException)
        {
            // Испорченный файл гасит переход, но не роняет опрос таблицы: запуск задачи перезапишет его.
            return [];
        }
    }

    private void Write(List<TaskSession> sessions)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new TaskSessionsFile(sessions), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record TaskSession(string Copy, string Session);

    private sealed record TaskSessionsFile(List<TaskSession> Sessions);
}
