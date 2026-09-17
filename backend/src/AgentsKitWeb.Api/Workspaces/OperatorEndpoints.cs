using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Неотвеченные вопросы копии и то, что оператор видит рядом с ними.</summary>
public sealed record QuestionsResponse(
    string Project,
    string Copy,
    string? Task,
    IReadOnlyList<ClosingCriterion> Criteria,
    string? OutOfScope,
    string? Design,
    IReadOnlyList<OperatorQuestion> Questions,
    bool VsCodeSession);

public sealed record AnswersRequest(string Base, string Copy, IReadOnlyList<OperatorAnswer> Answers);

public sealed record AnswersRejectedResponse(string Question, string Problem);

public sealed record OpenSessionRequest(string Base, string Copy);

public sealed record OpenSessionFailedResponse(string Problem);

public sealed record OpenWorkspaceRequest(string Base, string Copy);

public sealed record OpenWorkspaceFailedResponse(string Problem);

public static class OperatorEndpoints
{
    public static void MapOperatorEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/questions", (string @base, string copy, BasesStore bases, AgentSessions sessions) =>
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
                memory.Design,
                memory.Questions.Where(q => q.Answer is null).ToList(),
                sessions.VsCodeIn(memory.Copy!) is not null));
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
