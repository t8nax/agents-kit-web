using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Строка раздела «Сессии»: живая сессия Claude Code и копия, в которой она идёт. Session — короткий id
/// фоновой сессии, им её гасят и в неё входят; у сессии своего окна его нет.
/// StartedAt — время старта в миллисекундах epoch, как его пишет реестр.
/// </summary>
public sealed record SessionRow(
    string Path,
    string Project,
    string Base,
    string? Name,
    string? Session,
    string State,
    bool Background,
    long? StartedAt);

/// <summary>Действие над сессией адресуется её коротким id, а не путём: путь в запросе прав не даёт.</summary>
public sealed record SessionActionRequest(string? Session);

/// <summary>Почему действие не вышло: problem — чем именно, message — что сказал запуск.</summary>
public sealed record SessionActionProblem(string Problem, string? Message = null);

/// <summary>
/// Запуск сессии не под задачу: база и копия из списка панели, а не путь, и необязательная первая просьба.
/// </summary>
public sealed record SessionStartRequest(string? Base, string? Copy, string? Prompt);

/// <summary>
/// Заведённая сессия: её короткий id — им оператор в неё входит и ею её гасят. Terminal — открылось ли
/// окно с сессией: сессия завелась и без него, входят в неё тогда из строки перечня.
/// </summary>
public sealed record SessionStartResponse(string Session, bool Terminal);

public static partial class SessionsEndpoints
{
    // Короткий id сессии в реестре — шестнадцатеричный; чужой формат панель на слово не берёт.
    [GeneratedRegex("^[0-9a-f]{6,}$")]
    private static partial Regex SessionId { get; }

    public static void MapSessionsEndpoints(this IEndpointRouteBuilder app)
    {
        // Перечень живых сессий рабочих копий: копии идут в том же порядке, что в таблице копий, сессии
        // внутри копии — от старой к новой. Сессия каталога, который копией не числится, в перечень
        // не попадает — решение оператора на приёмке B-50.
        app.MapGet("/api/sessions", async (BasesStore bases, AgentSessions sessions, CancellationToken cancellationToken) =>
        {
            var rows = await WorkspaceCollector.CollectAsync(bases.List(), cancellationToken);
            var copies = new Dictionary<string, (WorkspaceRow Row, int Order)>(StringComparer.OrdinalIgnoreCase);
            foreach (var row in rows.Where(row => row.Error is null))
                copies.TryAdd(WorkspaceCollector.Normalize(row.Path), (row, copies.Count));

            var rowsOfCopies = new List<(SessionRow Row, int Order, long Started)>();
            foreach (var session in sessions.Live())
            {
                if (copies.TryGetValue(WorkspaceCollector.Normalize(session.Cwd), out var copy))
                    rowsOfCopies.Add((Row(session, copy.Row), copy.Order, session.StartedAt ?? long.MaxValue));
            }

            return rowsOfCopies
                .OrderBy(item => item.Order)
                .ThenBy(item => item.Started)
                .Select(item => item.Row)
                .ToList();
        });

        // Заведение сессии не под задачу: оператор открывает её, чтобы спросить, посмотреть, поработать руками.
        // Занятость копии здесь не проверяется: такая сессия задачи не берёт и памяти не заводит, а править те
        // же файлы рядом с идущей задачей — решение оператора, и предупреждает его окно.
        app.MapPost("/api/sessions/new", async (
            SessionStartRequest request,
            BasesStore bases,
            IAgentProcess agent,
            ITerminalWindows terminals,
            CancellationToken cancellationToken) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Copy))
                return Results.BadRequest();

            var rows = await WorkspaceCollector.CollectAsync([basePath], cancellationToken);
            var row = rows.FirstOrDefault(r => WorkspaceCollector.Normalize(r.Path)
                .Equals(WorkspaceCollector.Normalize(request.Copy), StringComparison.OrdinalIgnoreCase));
            if (row is null || row.Error is not null)
                return Results.NotFound();

            var prompt = request.Prompt?.Trim();
            var startInfo = Ask.BackgroundSession.StartInfo(row.Path, prompt);
            var (session, failure) = await Ask.BackgroundSession.StartAsync(agent, startInfo, cancellationToken);
            if (session is null)
                return Results.BadRequest(new SessionActionProblem("agent", failure));

            // Окно с сессией открывается сразу — решение оператора на приёмке B-61. Терминал адресуется
            // каталогом копии и id запуска, а не реестром: в нём заведённая сессия появляется не сразу.
            var terminal = await terminals.AttachAsync(row.Path, session, cancellationToken);
            return Results.Ok(new SessionStartResponse(session, terminal));
        });

        // Гашение фоновой сессии: панель просит сам claude остановить её по короткому id. Сессия со своим
        // окном так не гасится — её закрывает оператор там, где открыл.
        app.MapPost("/api/sessions/stop", async (
            SessionActionRequest request,
            AgentSessions sessions,
            IAgentProcess agent,
            CancellationToken cancellationToken) =>
        {
            if (Live(request, sessions) is not { } found)
                return Problem(request);

            return await SessionStop.StopAsync(agent, found, cancellationToken) is { } failure
                ? Failed(failure)
                : Results.NoContent();
        });

        // Переход в сессию: своего окна у фоновой нет, и панель открывает терминал, подключённый к ней
        // по её же каталогу из реестра.
        app.MapPost("/api/sessions/terminal", async (
            SessionActionRequest request,
            AgentSessions sessions,
            ITerminalWindows terminals,
            CancellationToken cancellationToken) =>
        {
            if (Live(request, sessions) is not { } found)
                return Problem(request);

            return await terminals.AttachAsync(found.Cwd, found.JobId!, cancellationToken)
                ? Results.NoContent()
                : Failed("терминал не открылся");
        });
    }

    // Действие идёт только над живой фоновой сессией: у неё есть короткий id, которым её и адресуют.
    private static AgentSession? Live(SessionActionRequest request, AgentSessions sessions)
    {
        var id = request.Session?.Trim();
        if (string.IsNullOrEmpty(id) || !SessionId.IsMatch(id))
            return null;

        var session = sessions.ByJobId(id);
        return session is { InBackground: true } ? session : null;
    }

    private static IResult Problem(SessionActionRequest request) =>
        string.IsNullOrWhiteSpace(request.Session) || !SessionId.IsMatch(request.Session.Trim())
            ? Results.BadRequest()
            : Results.Conflict(new SessionActionProblem("no-session"));

    private static IResult Failed(string message) =>
        Results.Json(new SessionActionProblem("agent", message), statusCode: StatusCodes.Status502BadGateway);

    private static SessionRow Row(AgentSession session, WorkspaceRow copy) => new(
        session.Cwd,
        copy.Project,
        copy.Base,
        session.Name,
        session.InBackground ? session.JobId : null,
        StateOf(session, copy),
        session.InBackground,
        session.StartedAt);

    /// <summary>
    /// Что делает сессия. Стоящая сессия копии, которая ждёт ответа оператора, без дела не стоит: её работа
    /// упёрлась в вопрос из файла памяти — замечание оператора на приёмке B-50. Какая из стоящих сессий копии
    /// этот вопрос задала, реестр не говорит, и ожидание показывается всем стоящим сессиям копии.
    /// </summary>
    private static string StateOf(AgentSession session, WorkspaceRow copy) =>
        session.State == SessionState.Idle && copy.Status == WorkspaceStatus.Waiting
            ? SessionState.AwaitingOperator
            : session.State;
}
