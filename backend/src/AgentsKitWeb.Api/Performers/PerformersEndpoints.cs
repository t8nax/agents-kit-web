using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Исполнитель — субагент проекта: файл в базе знаний, откуда кит развозит его по рабочим копиям.
/// Name — имя, которым зовёт его шаг флоу, Path — файл базы, откуда взяты поля.
/// Prompt — задание из файла: окно правки берёт его отсюда, а не отдельным запросом по пути к файлу.
/// CalledBy — названия этапов флоу, которые зовут его исполнителем или помощником: пока они есть, удалить его нельзя.
/// </summary>
public sealed record Performer(
    string Name,
    string? Description,
    string? Model,
    string? Tools,
    string Prompt,
    string Path,
    IReadOnlyList<string>? CalledBy = null);

/// <summary>
/// Исполнители одного проекта. Directory — каталог базы, куда лягут файлы: по нему окно показывает
/// путь ещё до сохранения. Error задан — показывать нечего. FormatWarning — база нового формата
/// (BaseLayout.NewerFormat): исполнители показываются, но не правятся.
/// </summary>
public sealed record BasePerformers(
    string Base,
    string Project,
    string Directory,
    IReadOnlyList<Performer> Performers,
    string? Error,
    string? FormatWarning = null);

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

/// <summary>
/// Problem: invalid-name · invalid-description · name-taken · name-in-project · not-committed · newer-format ·
/// called-by-flow (удаление; Detail — этапы через запятую).
/// </summary>
public sealed record PerformerRejectedResponse(string Problem, string? Detail = null);

public static class PerformersEndpoints
{
    public static void MapPerformersEndpoints(this IEndpointRouteBuilder app)
    {
        // Файлы читаются на каждый запрос: исполнителей правят и руками, и сессии в копиях.
        app.MapGet("/api/performers", (BasesStore bases) =>
        {
            var result = new List<BasePerformers>();
            foreach (var basePath in bases.List())
                result.Add(Read(basePath));
            return result;
        });

        app.MapPost("/api/performers", async (
            SavePerformerRequest request,
            BasesStore bases,
            HealthMonitor health,
            CancellationToken cancellationToken) =>
        {
            // Пишется только в личный репозиторий базы из списка панели: путь к файлу панель собирает сама.
            if (Configured(bases, request.Base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout)
                return Results.NotFound();
            // Исполнителей базы нового формата панель не пишет: её правила файла могли смениться (B-281).
            if (layout.NewerFormat)
                return Results.Conflict(new PerformerRejectedResponse("newer-format", BaseLayout.NewerFormatRefusal));
            // Git зовётся из личного репозитория: исполнитель коммитится в его git, и путь agents/… git берёт от него.
            var root = layout.Personal;

            var name = request.Name?.Trim();
            if (!PerformerFile.ValidName(name))
                return Results.BadRequest(new PerformerRejectedResponse("invalid-name"));

            // Описание стоит строкой шапки файла: перевод строки в нём оборвал бы шапку, и Claude Code
            // прочёл бы остаток как новые ключи. Переводы строк — все, что понимает разбор файла (ReplaceLineEndings).
            // Окно сводит описание в строку само, сюда такое не приходит.
            if (request.Description is { } description && description.AsSpan().IndexOfAny(LineBreaks) >= 0)
                return Results.BadRequest(new PerformerRejectedResponse("invalid-description"));

            var editing = request.Editing?.Trim();
            var editingSame = string.Equals(editing, name, StringComparison.Ordinal);
            var directory = PerformerList.Directory(layout);
            var file = System.IO.Path.Combine(directory, PerformerFile.FileName(name!));

            // Имена считаются по списку базы — так же, как их зовёт шаг флоу: у заведённого руками
            // файла имя может быть записано внутри, и тогда имя файла с ним расходится.
            var known = PerformerList.OfProject(layout);
            var was = editing is { Length: > 0 }
                ? known.FirstOrDefault(p => string.Equals(p.Name, editing, StringComparison.Ordinal))?.Path
                : null;

            // Имя в базе занято: молча переписать чужого исполнителя панель не станет. Своего же,
            // которого сейчас правят, она переписывает — за этим правку и открыли.
            if (!editingSame && known.Any(p => string.Equals(p.Name, name, StringComparison.Ordinal)))
                return Results.Conflict(new PerformerRejectedResponse("name-taken"));

            // Файл с таким именем есть, а правят не его — или не правят вовсе: так бывает, когда
            // у файла базы имя внутри разошлось с именем файла. Переписать его — потерять чужую
            // работу в чужом репозитории, поэтому отказ стоит и на заведении, и на правке.
            if (File.Exists(file) && !string.Equals(file, was ?? "", StringComparison.OrdinalIgnoreCase))
                return Results.Conflict(new PerformerRejectedResponse("name-taken"));

            // Имя занято файлом самого проекта: такой файл кит не трогает, и в копию исполнитель
            // не приедет. Проверяется только новое имя — у правимого оно уже стоит в базе.
            if (!editingSame && await ProjectAgents.TakenCopyAsync(basePath, name!, cancellationToken) is { } takenIn)
                return Results.Conflict(new PerformerRejectedResponse("name-in-project", takenIn));

            var fields = new PerformerFields(
                name,
                Trimmed(request.Description),
                Trimmed(request.Model),
                Trimmed(request.Tools),
                request.Prompt?.Trim() ?? "");

            // Прежний файл правимого исполнителя, когда он лежит не там, куда пишут: имя сменили или
            // файл был назван иначе, чем поле имени внутри него. Такой уходит тем же коммитом.
            var prior = was is not null && !string.Equals(was, file, StringComparison.OrdinalIgnoreCase) ? was : null;
            // Прежнее содержимое того, что переписывается: отказ коммита возвращает файлы как были,
            // иначе правка заведённого исполнителя стёрла бы его из базы вместе с отказом.
            var kept = await KeptAsync(prior ?? file, cancellationToken);
            var newline = kept is null ? "\n" : Newline(kept);

            try
            {
                System.IO.Directory.CreateDirectory(directory);
                await File.WriteAllTextAsync(file, PerformerFile.Serialize(fields, newline), cancellationToken);
                // Правка сменила имя — прежний файл уходит тем же коммитом, что приносит новый.
                if (prior is not null)
                    Remove(prior);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return Results.Problem("Файл исполнителя не записан", statusCode: StatusCodes.Status500InternalServerError);
            }

            var paths = new List<string> { Relative(file) };
            // Прежний файл идёт в коммит, только если git его знал: снятое из рабочего дерева
            // неотслеживаемое коммитить нечем, а `git commit -- путь` на таком отказывается вовсе.
            if (prior is not null && await BaseGit.TrackedAsync(root, Relative(prior), cancellationToken))
                paths.Add(Relative(prior));

            var added = await BaseGit.AddFileAsync(root, paths[0], cancellationToken);
            var commit = added.Done
                ? await BaseGit.CommitFilesAsync(root, paths, Message(name!, prior is not null), cancellationToken)
                : added;

            if (!commit.Done)
            {
                // Иначе база осталась бы с незакоммиченным исполнителем, а он уехал бы в чужой
                // коммит соседней сессии: вернуть всё как было и показать, что сказал git.
                Remove(file);
                await RestoreAsync(prior ?? file, kept, cancellationToken);
                await BaseGit.ResetFilesAsync(root, paths, cancellationToken);
                return Results.Conflict(new PerformerRejectedResponse("not-committed", commit.Error));
            }

            // Записанного исполнителя развозит по копиям фоновая проверка баз — её просят начать
            // сразу, чтобы он доехал к следующей сессии, а не через круг ожидания.
            health.RequestCheck();
            return Results.Ok(new PerformerSavedResponse(file));
        });

        app.MapDelete("/api/performers", async (
            string @base,
            string name,
            BasesStore bases,
            HealthMonitor health,
            CancellationToken cancellationToken) =>
        {
            if (Configured(bases, @base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout)
                return Results.NotFound();
            if (layout.NewerFormat)
                return Results.Conflict(new PerformerRejectedResponse("newer-format", BaseLayout.NewerFormatRefusal));
            var root = layout.Personal;

            // Файл ищется по списку базы, как его зовёт шаг флоу: имя внутри файла может расходиться с именем файла.
            name = name.Trim();
            if (PerformerList.OfProject(layout).FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.Ordinal))?.Path
                is not { } file)
                return Results.NotFound();

            // Кнопку окна гасит тот же список, но окно могло открыться до правки флоу: запрет держит и сама панель.
            // Этап, зовущий удалённого, агент бы не выполнил, — решение оператора на B-83.
            List<string> calledBy;
            try
            {
                calledBy = CalledBy(FlowEndpoints.Stages(layout), name);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return Results.Problem("Флоу базы не прочитан", statusCode: StatusCodes.Status500InternalServerError);
            }
            if (calledBy.Count > 0)
                return Results.Conflict(new PerformerRejectedResponse("called-by-flow", string.Join(", ", calledBy)));

            // Байты, а не текст: отказ коммита возвращает файл ровно таким, каким он лежал в базе под git.
            byte[] kept;
            try
            {
                kept = await File.ReadAllBytesAsync(file, cancellationToken);
                File.Delete(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return Results.Problem("Файл исполнителя не удалён", statusCode: StatusCodes.Status500InternalServerError);
            }

            // Неотслеживаемый файл — заведённый руками и не закоммиченный — уходит с диска, коммитить нечего.
            var path = Relative(file);
            if (await BaseGit.TrackedAsync(root, path, cancellationToken))
            {
                var commit = await BaseGit.CommitFileAsync(root, path, $"Исполнитель {name} удалён из панели", cancellationToken);
                if (!commit.Done)
                {
                    // Иначе удаление ушло бы в чужой коммит соседней сессии: вернуть файл и показать, что сказал git.
                    try
                    {
                        await File.WriteAllBytesAsync(file, kept, CancellationToken.None);
                    }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                    {
                        // Файла нет — об этом скажет сверка базы; оператору всё равно нужен ответ git.
                    }
                    await BaseGit.ResetFilesAsync(root, [path], cancellationToken);
                    return Results.Conflict(new PerformerRejectedResponse("not-committed", commit.Error));
                }
            }

            // Из рабочих копий удалённого убирает кит в фоновой проверке баз — её просят начать сразу.
            health.RequestCheck();
            return Results.NoContent();
        });
    }

    /// <summary>Названия этапов, которые зовут исполнителя — исполнителем этапа или помощником оркестратора.</summary>
    private static List<string> CalledBy(IReadOnlyList<FlowStage> stages, string name) =>
        stages
            .Where(s => string.Equals(s.Executor.Trim(), name, StringComparison.Ordinal) || FlowFolder.Helpers(s).Contains(name))
            .Select(s => s.Title)
            .ToList();

    private static BasePerformers Read(string basePath)
    {
        var project = ProjectName.Of(basePath);
        if (!System.IO.Directory.Exists(basePath))
            return new BasePerformers(basePath, project, "", [], "База не найдена на диске");
        // Личного репозитория у нечитаемой базы не опознать: каталог исполнителей не называется вовсе.
        if (BaseLayout.Read(basePath, out var problem) is not { } layout)
            return new BasePerformers(basePath, project, "", [], problem);

        // Флоу не прочитан — этапы никого не зовут: запрет удаления всё равно проверит запрос на удаление.
        IReadOnlyList<FlowStage> stages;
        try
        {
            stages = FlowEndpoints.Stages(layout);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            stages = [];
        }
        var performers = PerformerList.OfProject(layout)
            .Select(p => p with { CalledBy = CalledBy(stages, p.Name) })
            .ToList();

        return new BasePerformers(
            basePath, project, PerformerList.Directory(layout), performers, null, layout.FormatWarning);
    }

    /// <summary>Возвращает прежнее содержимое на место; не вышло — файла нет, и об этом скажет сверка базы.</summary>
    private static async Task RestoreAsync(string file, string? kept, CancellationToken cancellationToken)
    {
        if (kept is null)
            return;
        try
        {
            await File.WriteAllTextAsync(file, kept, cancellationToken);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Отказ записи при откате: показать оператору нужно всё равно то, что сказал git.
        }
    }

    /// <summary>Прежнее содержимое файла базы; файла нет — null, и откат просто уберёт написанное.</summary>
    private static async Task<string?> KeptAsync(string file, CancellationToken cancellationToken)
    {
        try
        {
            return File.Exists(file) ? await File.ReadAllTextAsync(file, cancellationToken) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Перевод строк прежнего файла: файл лежит в чужой базе под git, и смена перевода строк дала бы
    /// коммит, где изменился весь файл.
    /// </summary>
    private static string Newline(string text) => text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

    /// <summary>Путь файла от личного репозитория — таким его берут git add и git commit, запущенные из него.</summary>
    private static string Relative(string file) => PerformerList.Folder + "/" + System.IO.Path.GetFileName(file);

    private static string Message(string name, bool renamed) =>
        renamed ? $"Исполнитель {name} переименован из панели" : $"Исполнитель {name} записан из панели";

    /// <summary>Копии проекта, что есть на диске; первая копия из списка копий этой машины помечена основной.</summary>
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

    private const string LineBreaks = "\r\n\f\u0085\u2028\u2029";

    private static string? Trimmed(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>Копия проекта, где работает агент просьбы; Main — основная копия проекта.</summary>
public sealed record PerformerCopy(string Path, string Name, string? Branch, bool Main);
