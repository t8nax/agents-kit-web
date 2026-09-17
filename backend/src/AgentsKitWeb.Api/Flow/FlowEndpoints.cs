using System.Security.Cryptography;
using System.Text;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Флоу одной базы. Version — отпечаток файла: запись принимается только поверх того, что оператор видел.
/// ActiveTasks — задачи в работе: памяти work/*.md базы. Error задан — шагов панель не прочитала.
/// </summary>
public sealed record BaseFlow(
    string Base,
    string Project,
    IReadOnlyList<FlowStep> Steps,
    int ActiveTasks,
    string? Version,
    string? Error);

public sealed record SaveFlowRequest(string Base, string Version, IReadOnlyList<FlowStep> Steps);

public sealed record FlowSavedResponse(string Version);

/// <summary>Problem: changed · invalid · not-committed; Step и Detail — у invalid и not-committed.</summary>
public sealed record FlowRejectedResponse(string Problem, int? Step = null, string? Detail = null);

public sealed record OpenFlowRequest(string Base);

public static class FlowEndpoints
{
    private const string CommitMessage = "Флоу правлен из панели";
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    public static void MapFlowEndpoints(this IEndpointRouteBuilder app)
    {
        // Файл читается на каждый запрос: флоу правят и руками, и сессии агентов.
        app.MapGet("/api/flow", (BasesStore bases) => bases.List().Select(Read).ToList());

        app.MapPost("/api/flow", async (SaveFlowRequest request, BasesStore bases, CancellationToken cancellationToken) =>
        {
            // Пишется только flow.md базы из списка панели: путь к файлу панель собирает сама.
            if (Configured(bases, request.Base) is not { } basePath || !File.Exists(Path.Combine(basePath, FlowFile.FileName)))
                return Results.NotFound();

            var file = Path.Combine(basePath, FlowFile.FileName);
            var bytes = await File.ReadAllBytesAsync(file, cancellationToken);
            if (Fingerprint(bytes) != request.Version)
                return Results.Conflict(new FlowRejectedResponse("changed"));

            if (FlowFile.Validate(request.Steps) is { } rejection)
                return Results.BadRequest(new FlowRejectedResponse("invalid", rejection.Step, Problem(rejection.Problem)));

            var (text, hasBom) = Decode(bytes);
            var updated = FlowFile.Serialize(
                FlowFile.Parse(text) with { Steps = request.Steps },
                text.Contains("\r\n") ? "\r\n" : "\n");
            var output = new UTF8Encoding(false).GetBytes(updated);
            output = hasBom ? [.. Utf8Bom, .. output] : output;
            if (output.AsSpan().SequenceEqual(bytes))
                return Results.Ok(new FlowSavedResponse(request.Version));

            await WriteAsync(file, output, cancellationToken);
            var commit = await BaseGit.CommitFileAsync(basePath, FlowFile.FileName, CommitMessage, cancellationToken);
            if (!commit.Done)
            {
                // Незакоммиченный флоу прихватил бы чужой коммит соседней сессии: файл возвращается как был.
                await WriteAsync(file, bytes, CancellationToken.None);
                return Results.Json(
                    new FlowRejectedResponse("not-committed", Detail: commit.Error),
                    statusCode: StatusCodes.Status502BadGateway);
            }

            return Results.Ok(new FlowSavedResponse(Fingerprint(output)));
        });

        // Описания шагов панель не показывает: их читают в VS Code, в окне на каталоге базы.
        app.MapPost("/api/flow/open", async (
            OpenFlowRequest request,
            BasesStore bases,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            if (Configured(bases, request.Base) is not { } basePath || !File.Exists(Path.Combine(basePath, FlowFile.FileName)))
                return Results.NotFound();

            return await windows.OpenFileAsync(basePath, Path.Combine(basePath, FlowFile.FileName), cancellationToken)
                ? Results.NoContent()
                : Results.StatusCode(StatusCodes.Status502BadGateway);
        });
    }

    private static BaseFlow Read(string basePath)
    {
        var project = ProjectName.Of(basePath);

        if (!Directory.Exists(basePath))
            return new BaseFlow(basePath, project, [], 0, null, "База не найдена на диске");

        var file = Path.Combine(basePath, FlowFile.FileName);
        if (!File.Exists(file))
            return new BaseFlow(basePath, project, [], 0, null, "В базе нет flow.md");

        try
        {
            var bytes = File.ReadAllBytes(file);
            return new BaseFlow(
                basePath,
                project,
                FlowFile.Parse(Decode(bytes).Text).Steps,
                WorkspaceCollector.MemoryFiles(basePath).Count,
                Fingerprint(bytes),
                null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BaseFlow(basePath, project, [], 0, null, "Флоу базы не прочитан");
        }
    }

    private static string? Configured(BasesStore bases, string basePath)
    {
        var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        return configured is not null && Directory.Exists(configured) ? configured : null;
    }

    private static string Fingerprint(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static (string Text, bool HasBom) Decode(byte[] bytes)
    {
        var hasBom = bytes.AsSpan().StartsWith(Utf8Bom);
        var offset = hasBom ? Utf8Bom.Length : 0;
        return (new UTF8Encoding(false).GetString(bytes, offset, bytes.Length - offset), hasBom);
    }

    private static async Task WriteAsync(string file, byte[] bytes, CancellationToken cancellationToken)
    {
        var temp = file + ".panel-tmp";
        await File.WriteAllBytesAsync(temp, bytes, cancellationToken);
        File.Move(temp, file, overwrite: true);
    }

    private static string Problem(FlowProblem problem) => problem switch
    {
        FlowProblem.EmptyTitle => "empty-title",
        FlowProblem.EmptyExecutor => "empty-executor",
        FlowProblem.EmptyOutput => "empty-output",
        _ => "line-break",
    };
}
