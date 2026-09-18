using System.Diagnostics;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>Запуск задачи: база и копия из списка панели, а не путь, и номер записи бэклога.</summary>
public sealed record TaskStartRequest(string? Base, string? Copy, string? Number);

/// <summary>Заведённая сессия: её короткий id — им оператор входит в неё из терминала.</summary>
public sealed record TaskStartResponse(string Session);

/// <summary>Почему задача не запущена: problem — чем именно, message — что сказал запуск.</summary>
public sealed record TaskStartProblem(string Problem, string? Message = null);

public static partial class TaskEndpoints
{
    // Номер записи бэклога; кириллическая «В-7» — тот же номер, что «B-7».
    [GeneratedRegex(@"^[BВ]-\d+$")]
    private static partial Regex NumberFormat { get; }

    public static void MapTaskEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/tasks", async (
            TaskStartRequest request,
            BasesStore bases,
            StartedTasks started,
            TaskSessions taskSessions,
            IAgentProcess agent,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Copy) || string.IsNullOrWhiteSpace(request.Number))
                return Results.BadRequest();

            var number = Latin(request.Number.Trim());
            if (!NumberFormat.IsMatch(number))
                return Results.BadRequest();

            var rows = await WorkspaceCollector.CollectAsync([basePath], cancellationToken);
            var copy = request.Copy;
            var row = rows.FirstOrDefault(r => WorkspaceCollector.Normalize(r.Path)
                .Equals(WorkspaceCollector.Normalize(copy), StringComparison.OrdinalIgnoreCase));
            if (row is null || row.Error is not null)
                return Results.NotFound();

            // Копия занята задачей — своя память уже заведена; отметка о недавнем запуске больше не нужна.
            if (row.Status != WorkspaceStatus.Free)
            {
                started.Forget(row.Path);
                return Results.BadRequest(new TaskStartProblem("copy-busy", row.Task));
            }
            if (started.SessionIn(row.Path) is { } running)
                return Results.BadRequest(new TaskStartProblem("copy-starting", running));

            if (!Entries(basePath).TryGetValue(number, out var title))
                return Results.BadRequest(new TaskStartProblem("record-unknown"));

            var (session, failure) = await BackgroundSession.StartAsync(agent, StartInfo(row.Path, number), cancellationToken);
            if (session is null)
                return Results.BadRequest(new TaskStartProblem("agent", failure));

            // Номер с заголовком записи — всё, что панель знает о задаче, пока агент не завёл память:
            // из них и стоит задача в строке копии, чтобы не числить её свободной (Tasks/StartedTasks).
            started.Add(row.Path, session, $"{number} {title}");
            // Переход в сессию копии ведёт по этой записи: чем ещё узнать ту самую, панель не знает.
            taskSessions.Remember(row.Path, session);
            return Results.Ok(new TaskStartResponse(session));
        });
    }

    /// <summary>
    /// Задачу берёт навык кита: правила взятия записи и заведения памяти держит кит, панель их не повторяет.
    /// </summary>
    public static ProcessStartInfo StartInfo(string copyPath, string number) =>
        BackgroundSession.StartInfo(copyPath, $"/agents-kit:drive {number}");

    /// <summary>Записи бэклога базы: номер — заголовок. Бэклога нет или он не прочитан — записей нет.</summary>
    private static Dictionary<string, string> Entries(string basePath)
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(basePath, "backlog.md"));
            return Backlog.Parse(text)
                .Where(e => e.Number is not null)
                .GroupBy(e => Latin(e.Number!))
                .ToDictionary(g => g.Key, g => g.First().Title);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
        {
            return [];
        }
    }

    private static string Latin(string number) => number.Replace('В', 'B');
}
