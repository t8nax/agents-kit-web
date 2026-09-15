namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Неотвеченные вопросы копии и то, что оператор видит рядом с ними.</summary>
public sealed record QuestionsResponse(
    string Project,
    string Copy,
    string? Task,
    IReadOnlyList<string> Criterion,
    IReadOnlyList<OperatorQuestion> Questions);

public sealed record AnswersRequest(string Base, string Copy, IReadOnlyList<OperatorAnswer> Answers);

public sealed record AnswersRejectedResponse(string Question, string Problem);

public static class OperatorEndpoints
{
    public static void MapOperatorEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/questions", (string @base, string copy, IConfiguration configuration) =>
        {
            if (FindMemory(configuration, @base, copy) is not { } found)
                return Results.NotFound();

            var (_, memory) = found;
            return Results.Ok(new QuestionsResponse(
                new DirectoryInfo(@base.TrimEnd('\\', '/')).Name,
                memory.Copy!,
                memory.Task,
                memory.Criterion,
                memory.Questions.Where(q => q.Answer is null).ToList()));
        });

        app.MapPost("/api/answers", async (AnswersRequest request, IConfiguration configuration, CancellationToken cancellationToken) =>
        {
            if (FindMemory(configuration, request.Base, request.Copy) is not { } found)
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

    // Пишется только память копии из work/ базы, которая есть в настройке Bases:
    // путь к файлу панель не принимает, а собирает сама.
    private static (string File, WorkMemory Memory)? FindMemory(IConfiguration configuration, string basePath, string copy)
    {
        var bases = configuration.GetSection("Bases").Get<string[]>() ?? [];
        var configured = bases.FirstOrDefault(b =>
            string.Equals(WorkspaceCollector.Normalize(b), WorkspaceCollector.Normalize(basePath), StringComparison.OrdinalIgnoreCase));
        if (configured is null || !Directory.Exists(configured))
            return null;

        return WorkspaceCollector.MemoryFiles(configured).TryGetValue(WorkspaceCollector.Normalize(copy), out var found)
            ? found
            : null;
    }

    private static AnswersRejectedResponse Rejected(AnswerRejection rejection) => new(
        rejection.Question,
        rejection.Problem switch
        {
            AnswerProblem.Empty => "empty",
            AnswerProblem.Missing => "missing",
            _ => "already-answered",
        });
}
