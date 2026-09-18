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
    /// <summary>Заведение фоновой сессии — не разговор с агентом: дольше этого оно не идёт.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    // Номер записи бэклога; кириллическая «В-7» — тот же номер, что «B-7».
    [GeneratedRegex(@"^[BВ]-\d+$")]
    private static partial Regex NumberFormat { get; }

    // Короткий id фоновой сессии в выводе claude: «backgrounded · 7339dced».
    [GeneratedRegex(@"backgrounded[^0-9a-f]*(?<id>[0-9a-f]{6,})")]
    private static partial Regex Backgrounded { get; }

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

            if (!Entries(basePath).Contains(number))
                return Results.BadRequest(new TaskStartProblem("record-unknown"));

            var (session, failure) = await StartAsync(agent, row.Path, number, cancellationToken);
            if (session is null)
                return Results.BadRequest(new TaskStartProblem("agent", failure));

            started.Add(row.Path, session);
            // Переход в сессию копии ведёт по этой записи: чем ещё узнать ту самую, панель не знает.
            taskSessions.Remember(row.Path, session);
            return Results.Ok(new TaskStartResponse(session));
        });
    }

    /// <summary>
    /// Заводит фоновую сессию агента в каталоге копии и возвращает её id из вывода claude. Задачу берёт навык
    /// кита: правила взятия записи и заведения памяти держит кит, панель их не повторяет.
    /// </summary>
    private static async Task<(string? Session, string? Failure)> StartAsync(
        IAgentProcess agent, string copyPath, string number, CancellationToken cancellationToken)
    {
        var output = new List<string>();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);

        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(StartInfo(copyPath, number), "", line =>
            {
                output.Add(line);
                return Task.CompletedTask;
            }, timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (null, "claude не завёл сессию за две минуты");
        }

        var said = string.Join("\n", output).Trim();
        if (exit.ExitCode is null)
            return (null, exit.Error.Length > 0 ? exit.Error : "claude не запустился");

        var match = Backgrounded.Match(said);
        if (!match.Success)
        {
            var text = new[] { said, exit.Error }.FirstOrDefault(t => t.Length > 0);
            return (null, text ?? $"claude завершился с кодом {exit.ExitCode} и ничего не сказал");
        }
        return (match.Groups["id"].Value, null);
    }

    /// <summary>
    /// Сессия заводится фоновой (--bg): она переживает панель, оператор входит в неё «claude attach &lt;id&gt;»
    /// и гасит «claude stop &lt;id&gt;». Прав панель не навязывает — сессия идёт в обычном режиме оператора.
    /// </summary>
    public static ProcessStartInfo StartInfo(string copyPath, string number)
    {
        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath);
        startInfo.ArgumentList.Add("--bg");
        startInfo.ArgumentList.Add($"/agents-kit:drive {number}");
        return startInfo;
    }

    private static HashSet<string> Entries(string basePath)
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(basePath, "backlog.md"));
            return Backlog.Parse(text).Select(e => e.Number).OfType<string>().Select(Latin).ToHashSet();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
        {
            return [];
        }
    }

    private static string Latin(string number) => number.Replace('В', 'B');
}
