using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Flow;

/// <summary>
/// Флоу одной базы: стадии flow/stages/ и флоу из flow/flow.md. Version — отпечаток всех этих файлов: запись
/// принимается только поверх того, что оператор видел. У базы без flow/flow.md — и когда флоу в ней ещё старой
/// формы — флоу нет, а стадии, если они лежат в flow/stages/, читаются: первая запись не должна их стереть.
/// ActiveTasks — задачи в работе: памяти work/*.md базы. Error задан — флоу панель не прочитала. Icons — выбранные
/// оператором значки стадий, они живут в настройках панели, а не в базе. Unread — строки файлов флоу, которые панель
/// не сохранит («flow/flow.md, строка 7: «…»»): пока они есть, флоу не пишется, иначе запись стёрла бы их из базы.
/// Tasks — задачи в работе и флоу, по которому каждая идёт: занятый флоу и его стадии не правятся.
/// </summary>
public sealed record BaseFlow(
    string Base,
    string Project,
    IReadOnlyList<FlowStage> Stages,
    IReadOnlyList<NamedFlow> Flows,
    int ActiveTasks,
    string? Version,
    string? Error,
    IReadOnlyDictionary<string, string> Icons,
    IReadOnlyList<string>? Unread = null,
    IReadOnlyList<FlowTask>? Tasks = null);

/// <summary>
/// Задача в работе: Task — её номер из бэклога, а без номера — заголовок памяти или имя файла; Flow — флоу базы,
/// названный строкой «флоу:» памяти. Flow null — флоу не назван или такого в базе нет: такая задача может идти
/// по любому флоу и держит их все — решение оператора на B-226.
/// </summary>
public sealed record FlowTask(string Task, string? Flow);

/// <summary>Стадии и флоу базы целиком: стадия без слага заведена в панели, стадии, которой нет в списке, удаляются.</summary>
public sealed record SaveFlowRequest(
    string Base,
    string Version,
    IReadOnlyList<FlowStage> Stages,
    IReadOnlyList<NamedFlow> Flows,
    IReadOnlyDictionary<string, string>? Icons = null);

public sealed record FlowSavedResponse(string Version);

/// <summary>
/// Problem: changed · not-written · not-committed · not-restored · unread · проблема из FlowFolder.Validate; Flow и Stage —
/// где она, Detail — что сказали запись или git, или первая строка, которую панель не сохранит.
/// </summary>
public sealed record FlowRejectedResponse(string Problem, string? Flow = null, string? Stage = null, string? Detail = null);

public sealed record OpenFlowRequest(string Base);

public static class FlowEndpoints
{
    private const string CommitMessage = "Флоу правлен из панели";

    public static void MapFlowEndpoints(this IEndpointRouteBuilder app)
    {
        // Файлы читаются на каждый запрос: флоу правят и руками, и сессии агентов.
        app.MapGet("/api/flow", (BasesStore bases, FlowIconsStore icons) =>
            bases.List().Select(basePath => Read(basePath, icons)).ToList());

        app.MapPost("/api/flow", async (
            SaveFlowRequest request,
            BasesStore bases,
            FlowIconsStore icons,
            CancellationToken cancellationToken) =>
        {
            // Пишется только flow/ базы из списка панели: пути к файлам панель собирает сама.
            if (Configured(bases, request.Base) is not { } basePath)
                return Results.NotFound();

            var files = Files(basePath);
            if (FlowFolder.Fingerprint(files.Select(f => (f.Path, f.Bytes))) != request.Version)
                return Results.Conflict(new FlowRejectedResponse("changed"));

            // Строки, которых панель не сохранит, запись стёрла бы молча: пока их не поправили руками, флоу не пишется.
            if (Unread(files).FirstOrDefault() is { } unread)
                return Results.BadRequest(new FlowRejectedResponse("unread", Detail: unread));

            if (FlowFolder.Validate(request.Stages, request.Flows) is { } rejection)
                return Results.BadRequest(new FlowRejectedResponse(rejection.Problem, rejection.Flow, rejection.Stage));

            var writes = Plan(basePath, files, request);
            // Значки живут в настройках панели: файлы могли не измениться, а значок стадии — да.
            icons.Save(basePath, request.Icons);

            if (writes.Count == 0)
                return Results.Ok(new FlowSavedResponse(request.Version));

            if (await CommitAsync(basePath, writes, cancellationToken) is { } failure)
                return Results.Json(
                    new FlowRejectedResponse(failure.Problem, Detail: failure.Detail),
                    statusCode: StatusCodes.Status502BadGateway);

            return Results.Ok(new FlowSavedResponse(FlowFolder.Fingerprint(Files(basePath).Select(f => (f.Path, f.Bytes)))));
        });

        app.MapGet("/api/presets", (PresetsStore presets) => presets.List());

        // Пресет — стадия в форме кита: иначе выбранная из списка она не сохранится во флоу.
        app.MapPost("/api/presets", (FlowStage stage, PresetsStore presets) =>
        {
            // Помощники в пресет не уходят: они исполнители своего проекта, и в чужом их нет — решение оператора.
            var plain = stage with { Helpers = [], Slug = null };
            return FlowFolder.StageProblem(plain) is { } problem
                ? Results.BadRequest(new FlowRejectedResponse(problem))
                : Results.Ok(presets.Add(plain));
        });

        app.MapDelete("/api/presets/{id}", (string id, PresetsStore presets) =>
            presets.Remove(id) ? Results.NoContent() : Results.NotFound());

        // Флоу целиком читают в VS Code, в окне на каталоге базы: список флоу, а без него — первую стадию,
        // чтобы строку, которую панель не сохранит, было где поправить.
        app.MapPost("/api/flow/open", async (
            OpenFlowRequest request,
            BasesStore bases,
            IEditorWindows windows,
            CancellationToken cancellationToken) =>
        {
            if (Configured(bases, request.Base) is not { } basePath || Files(basePath).FirstOrDefault() is not { } first)
                return Results.NotFound();

            var file = Path.GetFullPath(Path.Combine(basePath, first.Path));
            return await windows.OpenFileAsync(basePath, file, cancellationToken)
                ? Results.NoContent()
                : Results.StatusCode(StatusCodes.Status502BadGateway);
        });
    }

    /// <summary>Файл флоу базы: путь от корня базы через «/» и байты как на диске.</summary>
    private sealed record FlowFileBytes(string Path, byte[] Bytes);

    /// <summary>Правка одного файла: Bytes — что записать (null — удалить), Before — что было (null — файла не было).</summary>
    private sealed record FileWrite(string Path, byte[]? Bytes, byte[]? Before);

    /// <summary>
    /// flow/flow.md, если он есть, — всегда первым, — и файлы стадий. Стадии читаются и без flow/flow.md: они лежат
    /// в базе, и первая запись флоу не должна ни занять их имена файлов, ни стереть их.
    /// </summary>
    private static List<FlowFileBytes> Files(string basePath)
    {
        var list = Path.Combine(basePath, FlowFolder.ListFile);
        var files = new List<FlowFileBytes>();
        if (File.Exists(list))
            files.Add(new(FlowFolder.ListFile, File.ReadAllBytes(list)));
        var stages = Path.Combine(basePath, FlowFolder.StagesFolder);
        if (Directory.Exists(stages))
            files.AddRange(Directory.EnumerateFiles(stages, "*.md")
                .Select(f => new FlowFileBytes($"{FlowFolder.StagesFolder}/{Path.GetFileName(f)}", File.ReadAllBytes(f))));
        return files;
    }

    private static BaseFlow Read(string basePath, FlowIconsStore icons)
    {
        var project = ProjectName.Of(basePath);

        if (!Directory.Exists(basePath))
            return new BaseFlow(basePath, project, [], [], 0, null, "База не найдена на диске", Empty);

        try
        {
            var files = Files(basePath);
            var stages = Stages(files);
            var list = files.FirstOrDefault(f => f.Path == FlowFolder.ListFile);
            var flows = list is null ? [] : FlowFolder.ParseList(Text(list.Bytes), Titles(stages)).Flows;
            var tasks = Tasks(basePath, flows);
            return new BaseFlow(
                basePath,
                project,
                stages,
                flows,
                tasks.Count,
                FlowFolder.Fingerprint(files.Select(f => (f.Path, f.Bytes))),
                null,
                icons.Of(basePath),
                Unread(files),
                tasks);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new BaseFlow(basePath, project, [], [], 0, null, "Флоу базы не прочитан", Empty);
        }
    }

    /// <summary>Задачи в работе по памятям work/*.md и флоу каждой: имя флоу сравнивается, как их сравнивает кит.</summary>
    private static List<FlowTask> Tasks(string basePath, IReadOnlyList<NamedFlow> flows) =>
        WorkspaceCollector.MemoryFiles(basePath).Values
            .Select(entry => new FlowTask(
                TaskLabel(entry.Memory.Task, entry.File),
                entry.Memory.Flow is { } named
                    ? flows.FirstOrDefault(f => FlowFolder.Key(f.Name) == FlowFolder.Key(named))?.Name
                    : null))
            .OrderBy(t => t.Task, StringComparer.Ordinal)
            .ToList();

    /// <summary>Номер записи бэклога в начале заголовка; без него — заголовок, а без заголовка — имя файла памяти.</summary>
    private static string TaskLabel(string? title, string file)
    {
        if (string.IsNullOrWhiteSpace(title))
            return System.IO.Path.GetFileNameWithoutExtension(file);
        var first = title.Split(' ', 2)[0];
        return BacklogNumber.Normalize(first) ?? title;
    }

    private static List<FlowStage> Stages(IEnumerable<FlowFileBytes> files) =>
        files.Where(f => f.Path.StartsWith(FlowFolder.StagesFolder + "/"))
            .Select(f => FlowFolder.ParseStage(Text(f.Bytes), System.IO.Path.GetFileNameWithoutExtension(f.Path)))
            .OrderBy(s => s.Slug, StringComparer.Ordinal)
            .ToList();

    /// <summary>Непонятые строки всех файлов флоу — с путём файла, чтобы их было где поправить.</summary>
    private static List<string> Unread(List<FlowFileBytes> files)
    {
        var unread = new List<string>();
        foreach (var file in files)
        {
            var lines = file.Path == FlowFolder.ListFile
                ? FlowFolder.ParseList(Text(file.Bytes), new Dictionary<string, string>()).Unread
                : FlowFolder.ReadStage(Text(file.Bytes), System.IO.Path.GetFileNameWithoutExtension(file.Path)).Unread;
            unread.AddRange(lines.Select(line => $"{file.Path}, {line}"));
        }
        return unread;
    }

    private static Dictionary<string, string> Titles(IEnumerable<FlowStage> stages) =>
        stages.Where(s => s.Slug is not null).ToDictionary(s => s.Slug!, s => s.Title);

    private static string Text(byte[] bytes) => FlowFolder.Decode(bytes).Text;

    /// <summary>
    /// Что записать. Стадия пишется, только если она изменилась: файлы стадий правят и руками, и нетронутую
    /// панель переписала бы в свою разметку. Новая стадия получает слаг из названия; стадия, которой в списке
    /// нет, удаляется. Файл пишется с переводами строк и BOM, какие у него были.
    /// </summary>
    private static List<FileWrite> Plan(string basePath, List<FlowFileBytes> files, SaveFlowRequest request)
    {
        var existing = files.Where(f => f.Path != FlowFolder.ListFile)
            .ToDictionary(f => System.IO.Path.GetFileNameWithoutExtension(f.Path), f => f);
        var taken = new HashSet<string>(existing.Keys, StringComparer.OrdinalIgnoreCase);
        var slugs = new Dictionary<string, string>();
        var writes = new List<FileWrite>();

        foreach (var stage in request.Stages)
        {
            if (stage.Slug is { } slug && existing.TryGetValue(slug, out var file))
            {
                var (text, hasBom) = FlowFolder.Decode(file.Bytes);
                if (FlowFolder.ParseStage(text, slug) != stage)
                    writes.Add(new FileWrite(file.Path, FlowFolder.Encode(FlowFolder.SerializeStage(stage, Eol(text)), hasBom), file.Bytes));
                slugs[FlowFolder.Key(stage.Title)] = slug;
                continue;
            }

            var fresh = FlowFolder.NewSlug(stage.Title, taken);
            taken.Add(fresh);
            slugs[FlowFolder.Key(stage.Title)] = fresh;
            writes.Add(new FileWrite($"{FlowFolder.StagesFolder}/{fresh}.md", FlowFolder.Encode(FlowFolder.SerializeStage(stage), false), null));
        }

        var kept = request.Stages.Select(s => s.Slug).OfType<string>().ToHashSet();
        writes.AddRange(existing.Where(pair => !kept.Contains(pair.Key)).Select(pair => new FileWrite(pair.Value.Path, null, pair.Value.Bytes)));

        // Вступление flow.md остаётся как было; у базы без него — заголовок, какой заводит кит.
        var list = files.FirstOrDefault(f => f.Path == FlowFolder.ListFile);
        var (listText, listBom) = list is null ? ($"# {ProjectName.Of(basePath)} — флоу\n", false) : FlowFolder.Decode(list.Bytes);
        var intro = FlowFolder.ParseList(listText, new Dictionary<string, string>()).Intro;
        var output = FlowFolder.Encode(FlowFolder.SerializeList(intro, request.Flows, slugs, Eol(listText)), listBom);
        if (list is null || !output.AsSpan().SequenceEqual(list.Bytes))
            writes.Add(new FileWrite(FlowFolder.ListFile, output, list?.Bytes));

        return writes;
    }

    /// <summary>Почему запись не прошла: Problem — not-written · not-committed · not-restored, Detail — что сказали.</summary>
    private sealed record CommitFailure(string Problem, string Detail);

    /// <summary>
    /// Пишет файлы и коммитит их одним коммитом; null — прошло. Не прошло — все файлы возвращаются как были, а новые
    /// снимаются с индекса: незакоммиченный флоу прихватил бы чужой коммит соседней сессии. Начавшись, запись
    /// отменой запроса не рвётся: оборванная посередине, она оставила бы в базе половину правки.
    /// </summary>
    private static async Task<CommitFailure?> CommitAsync(string basePath, List<FileWrite> writes, CancellationToken cancellationToken)
    {
        var fresh = writes.Where(w => w.Before is null).Select(w => w.Path).ToList();
        // Удалённый файл, которого git не знал, коммитить нечего: git commit -- путь отказал бы на нём.
        var paths = new List<string>();
        foreach (var write in writes)
            if (write.Bytes is not null || await BaseGit.TrackedAsync(basePath, write.Path, cancellationToken))
                paths.Add(write.Path);

        CommitFailure? failure = null;
        // Файлов несколько: сорвалась запись одного — уже записанные возвращаются, как и при отказе коммита.
        try
        {
            foreach (var write in writes)
                await WriteAsync(Path.Combine(basePath, write.Path), write.Bytes, CancellationToken.None);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            failure = new CommitFailure("not-written", e.Message);
        }

        foreach (var path in failure is null ? fresh : [])
            if ((await BaseGit.AddFileAsync(basePath, path, CancellationToken.None)).Error is { } added)
            {
                failure = new CommitFailure("not-committed", added);
                break;
            }

        if (failure is null && paths.Count > 0
            && (await BaseGit.CommitFilesAsync(basePath, paths, CommitMessage, CancellationToken.None)).Error is { } refused)
            failure = new CommitFailure("not-committed", refused);

        if (failure is null)
            return null;

        if (fresh.Count > 0)
            await BaseGit.ResetFilesAsync(basePath, fresh, CancellationToken.None);
        var stuck = new List<string>();
        foreach (var write in writes)
        {
            try
            {
                await WriteAsync(Path.Combine(basePath, write.Path), write.Before, CancellationToken.None);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Файл, который не дал себя записать, остался прежним; а вот записанный и не вернувшийся — нет.
                var file = Path.Combine(basePath, write.Path);
                var back = write.Before is null
                    ? !File.Exists(file)
                    : File.Exists(file) && File.ReadAllBytes(file).AsSpan().SequenceEqual(write.Before);
                if (!back)
                    stuck.Add(write.Path);
            }
        }
        // Вернуть удалось не всё: оператору нельзя сказать «оставлены как были».
        return stuck.Count > 0 ? new CommitFailure("not-restored", $"{failure.Detail} Не вернулись: {string.Join(", ", stuck)}.") : failure;
    }

    private static string Eol(string text) => text.Contains("\r\n") ? "\r\n" : "\n";

    private static readonly IReadOnlyDictionary<string, string> Empty = new Dictionary<string, string>();

    private static string? Configured(BasesStore bases, string basePath)
    {
        var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        return configured is not null && Directory.Exists(configured) ? configured : null;
    }

    /// <summary>Пишет файл через временный рядом; null — удаляет.</summary>
    private static async Task WriteAsync(string file, byte[]? bytes, CancellationToken cancellationToken)
    {
        if (bytes is null)
        {
            if (File.Exists(file))
                File.Delete(file);
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temp = file + ".panel-tmp";
        try
        {
            await File.WriteAllBytesAsync(temp, bytes, cancellationToken);
            File.Move(temp, file, overwrite: true);
        }
        catch
        {
            // Временный файл рядом не оставляется: база увидела бы в нём чужой незакоммиченный файл.
            if (File.Exists(temp))
                File.Delete(temp);
            throw;
        }
    }
}
