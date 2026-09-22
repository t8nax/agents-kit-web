using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Tasks;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Неотвеченные вопросы копии и то, что оператор видит рядом с ними.</summary>
public sealed record QuestionsResponse(
    string Project,
    string Copy,
    string? Task,
    IReadOnlyList<ClosingCriterion> Criteria,
    string? OutOfScope,
    IReadOnlyList<TaskArtifact> Artifacts,
    IReadOnlyList<OperatorQuestion> Questions,
    bool VsCodeSession,
    bool BackgroundSession);

public sealed record AnswersRequest(string Base, string Copy, IReadOnlyList<OperatorAnswer> Answers);

public sealed record AnswersRejectedResponse(string Question, string Problem);

public sealed record OpenSessionRequest(string Base, string Copy);

public sealed record OpenSessionFailedResponse(string Problem);

public sealed record OpenWorkspaceRequest(string Base, string Copy);

public sealed record OpenWorkspaceFailedResponse(string Problem);

public sealed record OpenArtifactRequest(string Base, string Copy, int Index, string Address);

public sealed record OpenArtifactFailedResponse(string Problem);

public static class OperatorEndpoints
{
    public static void MapOperatorEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/questions", (string @base, string copy, BasesStore bases, AgentSessions sessions, TaskSessions tasks) =>
        {
            if (FindMemory(bases, @base, copy) is not { } found)
                return Results.NotFound();

            var (_, memory) = found;
            return Results.Ok(new QuestionsResponse(
                ProjectName.Of(@base),
                memory.Copy!,
                memory.Task,
                memory.Criteria,
                memory.OutOfScope,
                memory.Artifacts,
                memory.Questions.Where(q => q.Answer is null).ToList(),
                sessions.VsCodeIn(memory.Copy!) is not null,
                sessions.BackgroundIn(memory.Copy!, tasks.SessionIn(memory.Copy!)) is not null));
        });

        // Панель не запускает сессию, а поднимает окно уже идущей: перехода нет, пока сессии нет.
        app.MapPost("/api/session/open", async (
            OpenSessionRequest request,
            BasesStore bases,
            AgentSessions sessions,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            if (FindMemory(bases, request.Base, request.Copy) is not { } found)
                return Results.NotFound();

            var copy = found.Memory.Copy!;
            if (sessions.VsCodeIn(copy) is null)
                return Results.Conflict(new OpenSessionFailedResponse("no-session"));

            return await windows.RaiseAsync(copy, cancellationToken)
                ? Results.NoContent()
                : Results.Json(new OpenSessionFailedResponse("not-raised"), statusCode: StatusCodes.Status502BadGateway);
        });

        // Кнопка строки таблицы: копия открывается в VS Code — свободная и занятая одинаково.
        app.MapPost("/api/workspace/open", async (
            OpenWorkspaceRequest request,
            BasesStore bases,
            AgentSessions sessions,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            if (await FindCopy(bases, request.Base, request.Copy, cancellationToken) is not { } copy)
                return Results.NotFound();

            // Сессия копии идёт в VS Code — её окно поднимается; иначе открывается окно на папке,
            // а сессию в нём заводит оператор.
            return Opened(sessions.VsCodeIn(copy) is not null
                ? await windows.RaiseAsync(copy, cancellationToken)
                : await windows.OpenAsync(copy, cancellationToken));
        });

        // Переход в фоновую сессию задачи: своего окна у неё нет, и панель открывает терминал, подключённый
        // к ней по id своего запуска. Задачу панель тут не запускала или её сессия ушла — переходить не к чему:
        // в чужую сессию копии переход не ведёт — решение оператора на B-58.
        app.MapPost("/api/session/terminal", async (
            OpenSessionRequest request,
            BasesStore bases,
            AgentSessions sessions,
            TaskSessions tasks,
            ITerminalWindows terminals,
            CancellationToken cancellationToken) =>
        {
            if (await FindCopy(bases, request.Base, request.Copy, cancellationToken) is not { } copy)
                return Results.NotFound();

            if (sessions.BackgroundIn(copy, tasks.SessionIn(copy)) is not { JobId: { } jobId })
                return Results.Conflict(new OpenSessionFailedResponse("no-session"));

            return await terminals.AttachAsync(copy, jobId, cancellationToken)
                ? Results.NoContent()
                : Results.Json(new OpenSessionFailedResponse("not-opened"), statusCode: StatusCodes.Status502BadGateway);
        });

        // Файл-артефакт задачи открывается в VS Code, в окне копии задачи, — решение оператора на B-87.
        // Запрос называет артефакт номером в памяти, а не путём: файл, которого нет в «Артефактах»
        // памяти копии, по HTTP не открыть.
        app.MapPost("/api/artifact/open", async (
            OpenArtifactRequest request,
            BasesStore bases,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            if (FindMemory(bases, request.Base, request.Copy) is not { Memory: var memory }
                || request.Index < 0 || request.Index >= memory.Artifacts.Count
                // Окно шлёт номер из памяти, прочитанной при его открытии; агент мог с тех пор переписать
                // «Артефакты» — тогда под этим номером другой адрес, и открывать его нельзя.
                || memory.Artifacts[request.Index].Address != request.Address)
                return Results.NotFound();

            // Адрес без корня — путь от копии задачи; ссылки на сайт открывает браузер, а не панель.
            var address = memory.Artifacts[request.Index].Address;
            if (Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                return Results.BadRequest(new OpenArtifactFailedResponse("not-a-file"));
            // VS Code запускается через cmd /c, а .NET берёт аргумент в кавычки только из-за пробела:
            // & | < > ^ % и кавычку в пути cmd разобрал бы сам — открыл бы не тот файл или выполнил
            // хвост имени командой. Путь из памяти такой запрос не передаёт.
            if (address.IndexOfAny(CmdSpecial) >= 0)
                return Results.BadRequest(new OpenArtifactFailedResponse("unsafe-path"));
            var path = Path.GetFullPath(Path.Combine(memory.Copy!, address));
            // Артефактом бывает и папка: она открывается своим окном VS Code, как копия.
            var opened = File.Exists(path) ? windows.OpenFileAsync(memory.Copy!, path, cancellationToken)
                : Directory.Exists(path) ? windows.OpenAsync(path, cancellationToken)
                : null;
            if (opened is null)
                return Results.NotFound(new OpenArtifactFailedResponse("missing"));

            return await opened
                ? Results.NoContent()
                : Results.Json(new OpenArtifactFailedResponse("not-opened"), statusCode: StatusCodes.Status502BadGateway);
        });

        app.MapPost("/api/answers", async (AnswersRequest request, BasesStore bases, CancellationToken cancellationToken) =>
        {
            if (FindMemory(bases, request.Base, request.Copy) is not { } found)
                return Results.NotFound();

            var rejection = await OperatorAnswers.WriteAsync(found.File, request.Answers, cancellationToken);
            return rejection switch
            {
                null => Results.NoContent(),
                { Problem: AnswerProblem.Empty } => Results.BadRequest(Rejected(rejection)),
                _ => Results.Conflict(Rejected(rejection)),
            };
        });
    }

    private static readonly char[] CmdSpecial = ['&', '|', '<', '>', '^', '%', '"'];

    // Пишется только память копии из work/ базы, которая есть в списке баз панели:
    // путь к файлу панель не принимает, а собирает сама.
    private static (string File, WorkMemory Memory)? FindMemory(BasesStore bases, string basePath, string copy)
    {
        var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        if (configured is null || !Directory.Exists(configured))
            return null;

        return WorkspaceCollector.MemoryFiles(configured).TryGetValue(WorkspaceCollector.Normalize(copy), out var found)
            ? found
            : null;
    }

    // Копия берётся из тех же строк, что и таблица: путь из запроса сам по себе прав не даёт,
    // а открывать нечего там, где строка пришла с ошибкой.
    private static async Task<string?> FindCopy(
        BasesStore bases, string basePath, string copy, CancellationToken cancellationToken)
    {
        var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        if (configured is null)
            return null;

        var rows = await WorkspaceCollector.CollectAsync([configured], cancellationToken);
        var wanted = WorkspaceCollector.Normalize(copy);
        return rows.FirstOrDefault(row => row.Error is null
            && WorkspaceCollector.Normalize(row.Path).Equals(wanted, StringComparison.OrdinalIgnoreCase))?.Path;
    }

    private static IResult Opened(bool done) => done
        ? Results.NoContent()
        : Results.Json(new OpenWorkspaceFailedResponse("not-opened"), statusCode: StatusCodes.Status502BadGateway);

    private static AnswersRejectedResponse Rejected(AnswerRejection rejection) => new(
        rejection.Question,
        rejection.Problem switch
        {
            AnswerProblem.Empty => "empty",
            AnswerProblem.Missing => "missing",
            _ => "already-answered",
        });
}
