using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Исполнитель — субагент Claude Code, схлопнутый по имени: один и тот же файл в нескольких копиях —
/// один Performer, а не строка на копию. Source: copy — лежит в рабочих копиях проекта и правится
/// из панели; profile — лежит в профиле оператора, панель его только показывает.
/// Copy и Path — копия и файл, откуда взяты поля: основная копия, а нет его там — первая, где нашёлся.
/// Prompt — задание из файла: окно правки берёт его отсюда, а не отдельным запросом по пути к файлу.
/// In — копии, где файл есть, Differs — из них те, где он отличается от взятого.
/// Everywhere — исполнитель есть во всех копиях проекта и всюду одинаков: только таким шаг флоу
/// даёт поручить работу; у исполнителя профиля он true — из любой копии его видно и так.
/// </summary>
public sealed record Performer(
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt,
    string Path,
    string Source,
    string? Copy,
    IReadOnlyList<string> In,
    IReadOnlyList<string> Differs,
    bool Everywhere);

/// <summary>Копия проекта, куда панель может положить исполнителя; Main — та, что окно предлагает по умолчанию.</summary>
public sealed record PerformerCopy(string Path, string Name, string? Branch, bool Main);

/// <summary>Исполнители одного проекта. Error задан — копий панель не прочитала.</summary>
public sealed record BasePerformers(
    string Base,
    string Project,
    IReadOnlyList<PerformerCopy> Copies,
    IReadOnlyList<Performer> Performers,
    string? Error);

/// <summary>
/// Запрос называет базу, а не путь к файлу: путь панель собирает сама. Копии в запросе нет —
/// исполнитель заводится на весь проект и ложится в основную копию, а по остальным его разносит
/// синхронизация — решение оператора на B-77.
/// </summary>
public sealed record SavePerformerRequest(
    string Base,
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string? Prompt);

public sealed record PerformerSavedResponse(string Path);

/// <summary>Problem: invalid-name · no-main-copy · not-committed; Detail — вывод git, когда коммит не прошёл.</summary>
public sealed record PerformerRejectedResponse(string Problem, string? Detail = null);

public static class PerformersEndpoints
{
    /// <summary>
    /// Сообщение коммита говорит, что произошло на самом деле: заведён исполнитель или изменён
    /// заведённый. Про правку узнаём по файлу на диске, а не по слову окна: окно правки открывают
    /// и у того, чей файл успели удалить руками.
    /// </summary>
    private const string AddedMessage = "Исполнитель заведён из панели";

    private const string ChangedMessage = "Исполнитель изменён из панели";

    public static void MapPerformersEndpoints(this IEndpointRouteBuilder app)
    {
        // Файлы читаются на каждый запрос: исполнителей правят и руками, и сессии в копиях.
        app.MapGet("/api/performers", async (BasesStore bases, KitLocator kit, CancellationToken cancellationToken) =>
        {
            var profile = PerformerList.OfProfile(kit.ClaudeDir);
            var result = new List<BasePerformers>();
            foreach (var basePath in bases.List())
                result.Add(await ReadBaseAsync(basePath, profile, cancellationToken));
            return result;
        });

        app.MapPost("/api/performers", async (
            SavePerformerRequest request,
            BasesStore bases,
            CancellationToken cancellationToken) =>
        {
            // Пишется только в копию базы из списка панели: путь к файлу панель собирает сама.
            if (Configured(bases, request.Base) is not { } basePath)
                return Results.NotFound();

            // Исполнитель — про проект целиком: файл ложится в основную копию, и копию для этого не выбирают.
            var copies = await CopiesAsync(basePath, cancellationToken);
            var copy = copies.FirstOrDefault(c => c.Main);
            if (copy is null)
                return Results.Conflict(new PerformerRejectedResponse("no-main-copy"));

            var name = request.Name?.Trim();
            if (!PerformerFile.ValidName(name))
                return Results.BadRequest(new PerformerRejectedResponse("invalid-name"));

            var directory = PerformerList.AgentsDirectory(copy.Path);
            var file = System.IO.Path.Combine(directory, PerformerFile.FileName(name!));
            var fields = new PerformerFields(
                name,
                Trimmed(request.Description),
                Trimmed(request.Model),
                Trimmed(request.Tools),
                request.Prompt?.Trim() ?? "");

            var existed = File.Exists(file);
            try
            {
                System.IO.Directory.CreateDirectory(directory);
                await File.WriteAllTextAsync(file, PerformerFile.Serialize(fields), cancellationToken);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return Results.Problem("Файл исполнителя не записан", statusCode: StatusCodes.Status500InternalServerError);
            }

            // Новый файл в истории копии ещё не числится, а `commit -- путь` знает только отслеживаемое:
            // сперва git add тем же одним путём, чужого в индекс он не берёт.
            var relative = PerformerFile.Directory + "/" + PerformerFile.FileName(name!);
            var added = await PerformerGit.AddFileAsync(copy.Path, relative, cancellationToken);
            if (!added.Done)
                return Results.Conflict(new PerformerRejectedResponse("not-committed", added.Error));

            var committed = await PerformerGit.CommitFileAsync(
                copy.Path, relative, existed ? ChangedMessage : AddedMessage, cancellationToken);
            if (!committed.Done)
            {
                await PerformerGit.UnstageFileAsync(copy.Path, relative, cancellationToken);
                return Results.Conflict(new PerformerRejectedResponse("not-committed", committed.Error));
            }

            return Results.Ok(new PerformerSavedResponse(file));
        });
    }

    private static async Task<BasePerformers> ReadBaseAsync(
        string basePath, IReadOnlyList<Performer> profile, CancellationToken cancellationToken)
    {
        var project = ProjectName.Of(basePath);

        if (!System.IO.Directory.Exists(basePath))
            return new BasePerformers(basePath, project, [], profile, "База не найдена на диске");

        var copies = await CopiesAsync(basePath, cancellationToken);
        if (copies.Count == 0)
            return new BasePerformers(basePath, project, [], profile, "У проекта нет рабочих копий на диске");

        var performers = PerformerList.OfCopies(copies);
        performers.AddRange(profile);

        return new BasePerformers(basePath, project, copies, performers, null);
    }

    /// <summary>Копии проекта, что есть на диске; первая копия из agents-kit.json помечена основной.</summary>
    internal static async Task<IReadOnlyList<PerformerCopy>> CopiesAsync(string basePath, CancellationToken cancellationToken)
    {
        var main = WorkspaceCollector.ReadCopies(basePath) is { } configured
            ? WorkspaceCollector.NewCopySource(configured)
            : null;
        var rows = await WorkspaceCollector.CollectAsync([basePath], cancellationToken);
        return rows
            .Where(row => row.Error is null && System.IO.Directory.Exists(row.Path))
            .Select(row => new PerformerCopy(
                row.Path,
                new DirectoryInfo(row.Path.TrimEnd('\\', '/')).Name,
                row.Branch,
                main is not null && string.Equals(
                    WorkspaceCollector.Normalize(row.Path), WorkspaceCollector.Normalize(main),
                    StringComparison.OrdinalIgnoreCase)))
            .ToList();
    }

    private static string? Configured(BasesStore bases, string? requested) =>
        requested is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, requested));

    private static string? Trimmed(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
