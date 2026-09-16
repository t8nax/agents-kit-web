using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Workspaces;

public sealed record NewWorkspaceRequest(string? Base, string? Name);

/// <summary>Отказ завести копию: Problem — причина, Message — текст кита, когда причина в нём.</summary>
public sealed record NewWorkspaceRejectedResponse(string Problem, string? Message);

public static partial class NewWorkspaceEndpoint
{
    public static void MapNewWorkspaceEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/workspaces", async (
            NewWorkspaceRequest request, BasesStore bases, IConfiguration config, CancellationToken cancellationToken) =>
        {
            var name = string.IsNullOrWhiteSpace(request.Name) ? null : request.Name.Trim();
            // Имя проверяется до запуска: скрипт кита скажет то же самое, но зря заведёт процесс.
            if (name is not null && !KebabCase().IsMatch(name))
                return Results.BadRequest(new NewWorkspaceRejectedResponse("bad-name", null));

            // Копия заводится только от базы из списка панели: путь к репозиторию по HTTP не принимается.
            var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base ?? ""));
            if (configured is null || !Directory.Exists(configured))
                return Results.NotFound();

            var copy = (WorkspaceCollector.ReadCopies(configured) ?? []).FirstOrDefault(Directory.Exists);
            if (copy is null)
                return Results.BadRequest(new NewWorkspaceRejectedResponse("no-copy", null));

            var scripts = config["KitScripts"] ?? KitWorktreeAdd.DefaultScripts;
            if (!File.Exists(KitWorktreeAdd.ScriptFile(scripts)))
                return Results.BadRequest(new NewWorkspaceRejectedResponse("kit-missing", KitWorktreeAdd.ScriptFile(scripts)));

            var failure = await KitWorktreeAdd.RunAsync(scripts, copy, name, cancellationToken);
            return failure is null
                ? Results.NoContent()
                : Results.BadRequest(new NewWorkspaceRejectedResponse("script", failure.Message));
        });
    }

    // Имя копии — то же, что у кита: строчная латиница и цифры через дефис.
    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex KebabCase();
}
