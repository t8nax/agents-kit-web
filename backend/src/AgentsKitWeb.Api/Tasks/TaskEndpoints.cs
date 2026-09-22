using System.Diagnostics;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Запуск задачи: база и копия из списка панели, а не путь, номер записи бэклога и флоу, которым её вести, —
/// одно из имён флоу базы. Флоу не назван — выбирает его сама сессия, спросив оператора.
/// Words — начальные слова оператора, с которыми сессия начнёт работу; пустые — запуск без них.
/// </summary>
public sealed record TaskStartRequest(string? Base, string? Copy, string? Number, string? Flow = null, string? Words = null);

/// <summary>Заведённая сессия: её короткий id — им оператор входит в неё из терминала.</summary>
public sealed record TaskStartResponse(string Session);

/// <summary>Почему задача не запущена: problem — чем именно, message — что сказал запуск.</summary>
public sealed record TaskStartProblem(string Problem, string? Message = null);

public static class TaskEndpoints
{
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

            // Номер набран кириллицей или строчными — тот же номер (Workspaces/BacklogNumber).
            var number = BacklogNumber.Normalize(request.Number);
            if (number is null)
                return Results.BadRequest();

            // Имя флоу уходит в просьбу сессии: берётся то, что стоит в файле базы, а не присланное.
            string? flow = null;
            if (!string.IsNullOrWhiteSpace(request.Flow))
            {
                flow = FlowFolder.ReadFlows(basePath)
                    .FirstOrDefault(f => FlowFolder.Key(f.Name) == FlowFolder.Key(request.Flow))?.Name;
                if (flow is null)
                    return Results.BadRequest(new TaskStartProblem("flow-unknown"));
            }

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

            var (session, failure) = await BackgroundSession.StartAsync(agent, StartInfo(row.Path, number, flow, request.Words), cancellationToken);
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
    /// Флоу называется словами: названный оператором флоу навык берёт, не спрашивая. Начальные слова оператора
    /// идут той же просьбой, с новой строки: другого сообщения запущенной сессии панель не шлёт.
    /// </summary>
    public static ProcessStartInfo StartInfo(string copyPath, string number, string? flow = null, string? words = null)
    {
        var prompt = flow is null ? $"/agents-kit:drive {number}" : $"/agents-kit:drive {number} флоу «{flow}»";
        if (!string.IsNullOrWhiteSpace(words))
            prompt += "\n\n" + words.Trim();
        return BackgroundSession.StartInfo(copyPath, prompt);
    }

    /// <summary>
    /// Записи бэклога базы с буквами её проекта: номер — заголовок. Запись чужими буквами кит считает ошибкой
    /// и перенумерует, поэтому задачей её панель не запускает. Бэклога нет или он не прочитан — записей нет.
    /// </summary>
    private static Dictionary<string, string> Entries(string basePath)
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(basePath, "backlog.md"));
            var letters = Backlog.Letters(text);
            return Backlog.Parse(text)
                .Where(e => e.Number is not null && BacklogNumber.Letters(e.Number) == letters)
                .GroupBy(e => e.Number!)
                .ToDictionary(g => g.Key, g => g.First().Title);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
        {
            return [];
        }
    }
}
