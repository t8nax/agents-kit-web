using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Исполнитель — субагент Claude Code из набора профиля: файл один на машину, и виден он из любой
/// рабочей копии. Name — имя без приставки проекта, Path — файл, откуда взяты поля.
/// Prompt — задание из файла: окно правки берёт его отсюда, а не отдельным запросом по пути к файлу.
/// </summary>
public sealed record Performer(
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt,
    string Path);

/// <summary>
/// Исполнители одного проекта. Prefix — приставка его имён, Directory — каталог, куда лягут файлы:
/// по ним окно показывает путь ещё до сохранения. Error задан — показывать нечего.
/// </summary>
public sealed record BasePerformers(
    string Base,
    string Project,
    string Prefix,
    string Directory,
    IReadOnlyList<Performer> Performers,
    string? Error);

/// <summary>
/// Запрос называет базу, а не путь к файлу: путь панель собирает сама. Editing — имя правимого
/// исполнителя: совпало с Name — панель переписывает его файл, иначе занятое имя она бережёт.
/// </summary>
public sealed record SavePerformerRequest(
    string Base,
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string? Prompt,
    string? Editing);

public sealed record PerformerSavedResponse(string Path);

/// <summary>Problem: invalid-name · no-prefix · name-taken.</summary>
public sealed record PerformerRejectedResponse(string Problem, string? Detail = null);

public static class PerformersEndpoints
{
    public static void MapPerformersEndpoints(this IEndpointRouteBuilder app)
    {
        // Файлы читаются на каждый запрос: исполнителей правят и руками, и сессии в копиях.
        app.MapGet("/api/performers", (BasesStore bases, KitLocator kit) =>
        {
            var result = new List<BasePerformers>();
            foreach (var basePath in bases.List())
                result.Add(Read(basePath, kit.ClaudeDir));
            return result;
        });

        app.MapPost("/api/performers", async (
            SavePerformerRequest request,
            BasesStore bases,
            KitLocator kit,
            CancellationToken cancellationToken) =>
        {
            // Пишется только по базе из списка панели: путь к файлу панель собирает сама.
            if (Configured(bases, request.Base) is not { } basePath)
                return Results.NotFound();

            var prefix = PerformerName.Prefix(basePath);
            if (prefix.Length == 0)
                return Results.Conflict(new PerformerRejectedResponse("no-prefix"));

            var name = request.Name?.Trim();
            if (!PerformerFile.ValidName(name) || !PerformerFile.ValidName(PerformerName.Full(prefix, name!)))
                return Results.BadRequest(new PerformerRejectedResponse("invalid-name"));

            var full = PerformerName.Full(prefix, name!);
            var directory = PerformerList.Directory(kit.ClaudeDir);
            var file = System.IO.Path.Combine(directory, PerformerFile.FileName(full));

            // Имя у проекта занято: молча переписать чужого исполнителя панель не станет. Своего же,
            // которого сейчас правят, она переписывает — за этим правку и открыли.
            if (File.Exists(file) && !string.Equals(request.Editing?.Trim(), name, StringComparison.Ordinal))
                return Results.Conflict(new PerformerRejectedResponse("name-taken"));

            var fields = new PerformerFields(
                full,
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

            // Правка сменила имя — прежний файл остаётся лишним: его убирает та же запись.
            if (request.Editing?.Trim() is { Length: > 0 } was && !string.Equals(was, name, StringComparison.Ordinal))
                Remove(System.IO.Path.Combine(directory, PerformerFile.FileName(PerformerName.Full(prefix, was))));

            return Results.Ok(new PerformerSavedResponse(file));
        });
    }

    private static BasePerformers Read(string basePath, string claudeDir)
    {
        var project = ProjectName.Of(basePath);
        var directory = PerformerList.Directory(claudeDir);

        if (!System.IO.Directory.Exists(basePath))
            return new BasePerformers(basePath, project, "", directory, [], "База не найдена на диске");

        var prefix = PerformerName.Prefix(basePath);
        if (prefix.Length == 0)
            return new BasePerformers(
                basePath, project, "", directory, [],
                "Имя проекта не записать латиницей — такому проекту панель исполнителей не заводит");

        return new BasePerformers(basePath, project, prefix, directory, PerformerList.OfProject(claudeDir, prefix), null);
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

    private static void Remove(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Прежний файл остался на диске — исполнитель под новым именем всё равно записан.
        }
    }

    private static string? Configured(BasesStore bases, string? requested) =>
        requested is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, requested));

    private static string? Trimmed(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>Копия проекта, где работает агент просьбы; Main — основная копия проекта.</summary>
public sealed record PerformerCopy(string Path, string Name, string? Branch, bool Main);
