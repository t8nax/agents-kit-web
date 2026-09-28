using System.Diagnostics;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Запуск задачи: база и копия из списка панели, а не путь, номер записи бэклога и флоу, которым её вести, —
/// одно из имён флоу базы. Флоу не назван — выбирает его сама сессия, спросив оператора.
/// Words — начальные слова оператора, с которыми сессия начнёт работу; пустые — запуск без них.
/// </summary>
public sealed record TaskStartRequest(string? Base, string? Copy, string? Number, string? Flow = null, string? Words = null);

/// <summary>Задача, которая идёт в копии без сессии, — ей заводится сессия: база и копия из списка панели.</summary>
public sealed record TaskSessionRequest(string? Base, string? Copy);

/// <summary>Заведённая сессия: её короткий id — им оператор входит в неё из терминала.</summary>
public sealed record TaskStartResponse(string Session);

/// <summary>Почему задача не запущена: problem — чем именно, message — что сказал запуск.</summary>
public sealed record TaskStartProblem(string Problem, string? Message = null);

public static partial class TaskEndpoints
{
    /// <summary>Предел начальных слов оператора в знаках; тот же стоит у поля окна запуска.</summary>
    public const int WordsLimit = 8000;

    public static void MapTaskEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/tasks", async (
            TaskStartRequest request,
            BasesStore bases,
            StartedTasks started,
            TaskSessions taskSessions,
            IAgentProcess agent,
            ProjectTracker tracker,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Copy) || string.IsNullOrWhiteSpace(request.Number))
                return Results.BadRequest();

            // Номер набран кириллицей или строчными — тот же номер (Workspaces/BacklogNumber). Задача трекера
            // называется именем трекера и номером в нём, как у кита: «GitHub #37».
            var issue = TrackerIssueNumber(request.Number);
            var number = issue is null ? BacklogNumber.Normalize(request.Number) : $"GitHub #{issue}";
            if (number is null)
                return Results.BadRequest();

            // Имя флоу уходит в просьбу сессии: берётся то, что стоит во флоу оператора этой машины — его личном
            // репозитории, — а не присланное.
            string? flow = null;
            if (!string.IsNullOrWhiteSpace(request.Flow))
            {
                flow = (BaseLayout.Read(basePath) is { } layout ? FlowFolder.ReadFlows(layout.Personal) : [])
                    .FirstOrDefault(f => FlowFolder.Key(f.Name) == FlowFolder.Key(request.Flow))?.Name;
                if (flow is null)
                    return Results.BadRequest(new TaskStartProblem("flow-unknown"));
            }

            // Задачу трекера панель перепроверяет по GitHub: закрытую или назначенную не на оператора не запускает
            // — критерий B-277. До проверки копии: иначе между нею и запуском вставало бы ожидание GitHub.
            string? issueTitle = null;
            if (issue is not null)
            {
                if (BaseLayout.Read(basePath) is not { } layout)
                    return Results.NotFound();
                var issues = await tracker.AssignedAsync(layout, cancellationToken);
                if (issues.Problem is not null)
                    // Окну — код причины, его оно называет словами; строку GitHub — только когда кода у причины нет
                    return Results.BadRequest(new TaskStartProblem("tracker-unavailable",
                        issues.Problem == TrackerIssues.GitHubError ? issues.Detail : issues.Problem));
                issueTitle = issues.Issues.FirstOrDefault(i => i.Number == issue)?.Title;
                if (issueTitle is null)
                    return Results.BadRequest(new TaskStartProblem("issue-unknown"));
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
            // Та же задача запускается или идёт в другой копии проекта — вторая сессия над ней не заводится (B-89).
            // Запись бэклога агент вырезает не сразу, а задача GitHub остаётся в трекере всё время работы.
            var elsewhere = rows.FirstOrDefault(r => r != row && r.Error is null
                && TaskNumberOf(r.Status == WorkspaceStatus.Free ? started.TaskIn(r.Path) : r.Task, r.Letters) == number);
            if (elsewhere is not null)
                return Results.BadRequest(new TaskStartProblem("task-running", Path.GetFileName(elsewhere.Path)));

            // Слова уходят аргументом командной строки, а её длину Windows ограничивает: предел — с большим запасом.
            if (request.Words is { Length: > WordsLimit })
                return Results.BadRequest(new TaskStartProblem("words-too-long"));

            string? title = issueTitle;
            if (issue is null)
            {
                if (!Entries(basePath).TryGetValue(number, out title))
                    return Results.BadRequest(new TaskStartProblem("record-unknown"));
            }

            // Пока заводится сессия, строки копий о задаче ещё не знают: повтор её отбивает только этот захват.
            if (started.Claim(basePath, number, row.Path) is { } claimedBy)
                return Results.BadRequest(new TaskStartProblem("task-running", Path.GetFileName(claimedBy)));
            try
            {
                var (session, failure) = await BackgroundSession.StartAsync(agent, StartInfo(row.Path, number, flow, request.Words), cancellationToken);
                if (session is null)
                    return Results.BadRequest(new TaskStartProblem("agent", failure));

                // Номер с заголовком записи — всё, что панель знает о задаче, пока агент не завёл память:
                // из них и стоит задача в строке копии, чтобы не числить её свободной (Tasks/StartedTasks).
                started.Add(row.Path, session, $"{number} {title}");
                // Переход в сессию копии ведёт по этой записи: чем ещё узнать ту самую, панель не знает.
                taskSessions.Remember(row.Path, session);
                return Results.Ok(new TaskStartResponse(session));
            }
            finally
            {
                started.Release(basePath, number);
            }
        });

        // Сессия задачи умерла — после перезагрузки или ночью, — а память цела: новая сессия продолжает
        // задачу по памяти и становится сессией задачи, как заведённая при взятии (B-106, B-217).
        app.MapPost("/api/tasks/session", async (
            TaskSessionRequest request,
            BasesStore bases,
            AgentSessions sessions,
            TaskSessions taskSessions,
            ResumedSessions resumed,
            IAgentProcess agent,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Copy))
                return Results.BadRequest();

            var rows = sessions.Annotate(await WorkspaceCollector.CollectAsync([basePath], cancellationToken), taskSessions.SessionIn);
            var copy = request.Copy;
            var row = rows.FirstOrDefault(r => WorkspaceCollector.Normalize(r.Path)
                .Equals(WorkspaceCollector.Normalize(copy), StringComparison.OrdinalIgnoreCase));
            if (row is null || row.Error is not null)
                return Results.NotFound();

            // Продолжать нечего: памяти у копии нет, задачу берут из бэклога.
            if (row.Status is not (WorkspaceStatus.InWork or WorkspaceStatus.Waiting or WorkspaceStatus.Unread))
                return Results.BadRequest(new TaskStartProblem("no-task"));
            // Сессия задачи жива — вторая стала бы вести ту же задачу рядом с ней.
            if (row.BackgroundSession || row.VsCodeSession)
                return Results.BadRequest(new TaskStartProblem("session-alive"));
            // Прошлая заведённая сессия ещё не дошла до реестра — второй запрос её не видит (ResumedSessions).
            if (!resumed.TryStart(row.Path))
                return Results.BadRequest(new TaskStartProblem("session-starting"));

            var (session, failure) = await BackgroundSession.StartAsync(agent, ContinueInfo(row.Path), cancellationToken);
            if (session is null)
            {
                resumed.Forget(row.Path);
                return Results.BadRequest(new TaskStartProblem("agent", failure));
            }

            taskSessions.Remember(row.Path, session);
            return Results.Ok(new TaskStartResponse(session));
        });
    }

    /// <summary>
    /// Навык кита без номера продолжает задачу, память которой у копии уже есть: перечитывает её, вбирает
    /// ответы оператора и идёт с первой незакрытой строки.
    /// </summary>
    public static ProcessStartInfo ContinueInfo(string copyPath) =>
        BackgroundSession.StartInfo(copyPath, "/agents-kit:drive");

    /// <summary>
    /// Задачу берёт навык кита: правила взятия записи и заведения памяти держит кит, панель их не повторяет.
    /// Флоу называется словами: названный оператором флоу навык берёт, не спрашивая. Начальные слова оператора
    /// идут той же просьбой, с новой строки: другого сообщения запущенной сессии панель не шлёт.
    /// </summary>
    public static ProcessStartInfo StartInfo(string copyPath, string number, string? flow = null, string? words = null)
    {
        var prompt = flow is null ? $"/agents-kit:drive {number}" : $"/agents-kit:drive {number} флоу «{flow}»";
        if (!string.IsNullOrWhiteSpace(words))
            // Отступ первой строки — часть слов оператора: по краям срезаются только пустые строки.
            prompt += "\n\n" + words.TrimStart('\r', '\n').TrimEnd();
        return BackgroundSession.StartInfo(copyPath, prompt);
    }

    /// <summary>Номер задачи GitHub в имени «GitHub #37», регистр и пробел перед «#» ничего не значат; не оно — null.</summary>
    public static int? TrackerIssueNumber(string text) =>
        TrackerIssueName().Match(text.Trim()) is { Success: true } match && int.TryParse(match.Groups[1].Value, out var value) && value > 0
            ? value
            : null;

    [GeneratedRegex(@"^github\s*#(\d{1,9})$", RegexOptions.IgnoreCase)]
    private static partial Regex TrackerIssueName();

    /// <summary>
    /// Номер задачи, которым начат её заголовок в строке копии, в том виде, в каком запускается задача:
    /// «B-7 Заголовок» — «B-7» при буквах проекта «B», «GitHub #37 Заголовок» — «GitHub #37». Без номера — null.
    /// </summary>
    public static string? TaskNumberOf(string? task, string? letters) =>
        task is not null && TrackerIssueTitle().Match(task) is { Success: true } issue
            ? $"GitHub #{int.Parse(issue.Groups[1].Value)}"
            : BacklogNumber.OfTask(task, letters);

    [GeneratedRegex(@"^\s*github\s*#(\d{1,9})(?:\s|$)", RegexOptions.IgnoreCase)]
    private static partial Regex TrackerIssueTitle();

    /// <summary>
    /// Записи бэклога оператора с буквами проекта базы: номер — заголовок. Запись чужими буквами кит считает ошибкой
    /// и перенумерует, поэтому задачей её панель не запускает. Бэклога нет или он не прочитан — записей нет.
    /// </summary>
    private static Dictionary<string, string> Entries(string basePath)
    {
        try
        {
            if (BaseLayout.Read(basePath) is not { } layout)
                return [];
            var text = File.ReadAllText(layout.BacklogFile);
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
