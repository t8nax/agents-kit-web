using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Исполнитель — субагент Claude Code. Source: copy — лежит в рабочей копии проекта и правится из панели;
/// profile — лежит в профиле оператора, панель его только показывает. Copy — копия, в которой найден файл.
/// </summary>
public sealed record Performer(
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string Path,
    string Source,
    string? Copy);

/// <summary>Копия проекта, куда панель может положить исполнителя; Main — та, что окно предлагает по умолчанию.</summary>
public sealed record PerformerCopy(string Path, string Name, string? Branch, bool Main);

/// <summary>Исполнители одного проекта. Error задан — копий панель не прочитала.</summary>
public sealed record BasePerformers(
    string Base,
    string Project,
    IReadOnlyList<PerformerCopy> Copies,
    IReadOnlyList<Performer> Performers,
    string? Error);

/// <summary>Копия названа путём, как и в остальных запросах панели: база плюс копия, а не путь к файлу.</summary>
public sealed record SavePerformerRequest(
    string Base,
    string Copy,
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string? Prompt);

public sealed record PerformerSavedResponse(string Path);

/// <summary>Problem: invalid-name · not-committed; Detail — вывод git, когда коммит не прошёл.</summary>
public sealed record PerformerRejectedResponse(string Problem, string? Detail = null);

public static class PerformersEndpoints
{
    private const string CommitMessage = "Исполнитель заведён из панели";

    public static void MapPerformersEndpoints(this IEndpointRouteBuilder app)
    {
        // Файлы читаются на каждый запрос: исполнителей правят и руками, и сессии в копиях.
        app.MapGet("/api/performers", async (BasesStore bases, KitLocator kit, CancellationToken cancellationToken) =>
        {
            var profile = ReadProfile(kit.ClaudeDir);
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

            var copies = await CopiesAsync(basePath, cancellationToken);
            var copy = copies.FirstOrDefault(c =>
                string.Equals(WorkspaceCollector.Normalize(c.Path), WorkspaceCollector.Normalize(request.Copy),
                    StringComparison.OrdinalIgnoreCase));
            if (copy is null)
                return Results.NotFound();

            var name = request.Name?.Trim();
            if (!PerformerFile.ValidName(name))
                return Results.BadRequest(new PerformerRejectedResponse("invalid-name"));

            var directory = System.IO.Path.Combine(copy.Path, PerformerFile.Directory.Replace('/', '\\'));
            var file = System.IO.Path.Combine(directory, PerformerFile.FileName(name!));
            var fields = new PerformerFields(
                name,
                Trimmed(request.Description),
                Trimmed(request.Model),
                Trimmed(request.Tools),
                request.Prompt?.Trim() ?? "");

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

            var committed = await PerformerGit.CommitFileAsync(copy.Path, relative, CommitMessage, cancellationToken);
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

        var performers = new List<Performer>();
        foreach (var copy in copies)
            performers.AddRange(ReadDirectory(
                System.IO.Path.Combine(copy.Path, PerformerFile.Directory.Replace('/', '\\')), "copy", copy.Path));
        performers.AddRange(profile);

        return new BasePerformers(basePath, project, copies, performers, null);
    }

    /// <summary>Копии проекта, что есть на диске; первая копия из agents-kit.json помечена основной.</summary>
    private static async Task<IReadOnlyList<PerformerCopy>> CopiesAsync(string basePath, CancellationToken cancellationToken)
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

    /// <summary>Исполнители профиля оператора: панель их показывает, чтобы шаг флоу не считал их пропавшими.</summary>
    private static IReadOnlyList<Performer> ReadProfile(string claudeDir) =>
        ReadDirectory(System.IO.Path.Combine(claudeDir, "agents"), "profile", null);

    private static List<Performer> ReadDirectory(string directory, string source, string? copy)
    {
        var performers = new List<Performer>();
        if (!System.IO.Directory.Exists(directory))
            return performers;

        IEnumerable<string> files;
        try
        {
            files = System.IO.Directory.EnumerateFiles(directory, "*.md").OrderBy(f => f, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return performers;
        }

        foreach (var file in files)
        {
            string text;
            try
            {
                text = File.ReadAllText(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            var fields = PerformerFile.Parse(text);
            performers.Add(new Performer(
                // Шаг флоу зовёт субагента именем из поля name; его нет — Claude Code берёт имя файла.
                fields.Name ?? System.IO.Path.GetFileNameWithoutExtension(file),
                fields.Description,
                fields.Model,
                fields.Tools,
                file,
                source,
                copy));
        }
        return performers;
    }

    private static string? Configured(BasesStore bases, string? requested) =>
        requested is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, requested));

    private static string? Trimmed(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
