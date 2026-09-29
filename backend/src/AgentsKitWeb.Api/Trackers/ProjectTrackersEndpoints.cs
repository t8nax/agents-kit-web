using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>Задача трекера, которая идёт в рабочей копии: Task — заголовок её памяти, Copy — путь копии.</summary>
public sealed record TrackerTask(string Task, string? Copy);

/// <summary>
/// Строка карточки «Трекеры проектов» — одна база из списка панели (B-293). Problem — база не читается (слова раскладки);
/// Tracker — трекер, как его читает «Бэклог» (null — описания нет); Description — описание полями окна; Version —
/// отпечаток tracker.md, поверх которого пишется правка («» — файла нет); Busy — задачи этого трекера в работе:
/// пока они есть, описание не удаляется; NewerFormat — база нового формата кита, правка закрыта (B-281).
/// </summary>
public sealed record ProjectTrackerRow(
    string Base,
    string Project,
    string? Problem,
    TrackerInfo? Tracker,
    TrackerDescription? Description,
    string Version,
    IReadOnlyList<TrackerTask> Busy,
    bool NewerFormat);

public sealed record SaveProjectTrackerRequest(string? Base, string? Version, TrackerDescription? Description);

/// <summary>
/// Описание записано. Checked — панель проверила трекер чтением задач (у Jira и GitLab — нет); Pushed — база ушла
/// на сервер, иначе Message — слова кита, почему нет. Version — отпечаток записанного файла.
/// </summary>
public sealed record ProjectTrackerSaved(string Version, bool Checked, bool Pushed, string? Message);

/// <summary>
/// Запись не прошла. Problem: newer-format — база нового формата кита; invalid — описание не в форме кита (Faults — по
/// полям окна); check — трекер не прочитан (Field — поле, Code — причина кодами задач «Бэклога», Detail — строка
/// трекера); changed — описание поменялось с тех пор, как его видел оператор; dirty — в tracker.md чужая
/// незакоммиченная правка; busy — идут задачи трекера (Busy); kit-not-set, kit-not-found — нет кита или его sync.ps1;
/// no-copy — нет копии проекта на диске, скрипту кита свести базу не из чего; pull — базу не забрать с сервера
/// (Detail — слова кита); not-written, not-committed, not-restored — как у записи флоу.
/// </summary>
public sealed record ProjectTrackerRejected(
    string Problem,
    string? Detail = null,
    IReadOnlyDictionary<string, string>? Faults = null,
    string? Field = null,
    string? Code = null,
    IReadOnlyList<TrackerTask>? Busy = null);

public static partial class ProjectTrackersEndpoints
{
    public const string CommitMessage = "Изменить описание трекера из панели";
    public const string DeleteMessage = "Удалить описание трекера из панели";

    public static void MapProjectTrackersEndpoints(this IEndpointRouteBuilder app)
    {
        // Описания читаются на каждый запрос: их правят и сессии агентов скиллом кита.
        app.MapGet("/api/trackers/projects", (BasesStore bases) => bases.List().Select(Row).ToList());

        app.MapPut("/api/trackers/projects", async (
            SaveProjectTrackerRequest request, BasesStore bases, ProjectTracker tracker, CancellationToken cancellationToken) =>
        {
            if (Configured(bases, request.Base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout
                || request.Description is not { } description)
                return Results.NotFound();
            if (layout.NewerFormat)
                return Results.Conflict(new ProjectTrackerRejected("newer-format", BaseLayout.NewerFormatRefusal));

            // Форму кита панель держит сама: файл, который сверка кита назовёт красным, в базу не уходит.
            if (TrackerDescriptions.Faults(description) is { Count: > 0 } faults)
                return Results.BadRequest(new ProjectTrackerRejected("invalid", Faults: faults));

            if (SyncOf(bases, layout, out var unready) is not { } sync)
                return unready;

            if (await RefreshAsync(sync, layout, request.Version) is { } stale)
                return stale;

            // Проверка трекера — решение оператора на B-293: описание, по которому задач не прочитать, не пишется.
            var check = await tracker.CheckAsync(description, cancellationToken);
            if (!check.Passed)
                return Results.UnprocessableEntity(
                    new ProjectTrackerRejected("check", check.Detail, Field: check.Field, Code: check.Problem));

            var text = TrackerDescriptions.Serialize(description, ProjectName.Of(basePath));
            if (await CommitAsync(layout, Encoding.UTF8.GetBytes(text), CommitMessage) is { } failure)
                return Results.Json(failure, statusCode: StatusCodes.Status502BadGateway);

            var pushed = await KitSync.RunAsync(sync.Script, sync.Copy, KitSync.Push);
            return Results.Ok(new ProjectTrackerSaved(
                Version(layout.TrackerFile), check.Checked, pushed.Done, pushed.Done ? null : pushed.Message));
        });

        app.MapDelete("/api/trackers/projects", async (
            string? @base, string? version, BasesStore bases, CancellationToken cancellationToken) =>
        {
            if (Configured(bases, @base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout)
                return Results.NotFound();
            if (layout.NewerFormat)
                return Results.Conflict(new ProjectTrackerRejected("newer-format", BaseLayout.NewerFormatRefusal));

            // Удалить нельзя, пока идёт задача из этого трекера: сессии нечем было бы её закрыть — ответ оператора на B-293.
            if (Busy(layout) is { Count: > 0 } busy)
                return Results.Conflict(new ProjectTrackerRejected("busy", Busy: busy));

            if (SyncOf(bases, layout, out var unready) is not { } sync)
                return unready;

            if (await RefreshAsync(sync, layout, version) is { } stale)
                return stale;
            // Задача могла прийти с сервера вместе с базой.
            if (Busy(layout) is { Count: > 0 } arrived)
                return Results.Conflict(new ProjectTrackerRejected("busy", Busy: arrived));
            if (!File.Exists(layout.TrackerFile))
                return Results.Conflict(new ProjectTrackerRejected("changed"));

            if (await CommitAsync(layout, null, DeleteMessage) is { } failure)
                return Results.Json(failure, statusCode: StatusCodes.Status502BadGateway);

            var pushed = await KitSync.RunAsync(sync.Script, sync.Copy, KitSync.Push);
            return Results.Ok(new ProjectTrackerSaved("", false, pushed.Done, pushed.Done ? null : pushed.Message));
        });
    }

    /// <summary>Строка карточки по базе из списка панели.</summary>
    public static ProjectTrackerRow Row(string basePath)
    {
        var project = ProjectName.Of(basePath);
        if (BaseLayout.Read(basePath, out var problem) is not { } layout)
            return new ProjectTrackerRow(basePath, project, problem ?? "База не читается", null, null, "", [], false);

        var file = layout.TrackerFile;
        TrackerDescription? description = null;
        try
        {
            if (File.Exists(file))
                description = TrackerDescriptions.Parse(File.ReadAllText(file));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Не прочитали — Tracker скажет «unreadable», и окно не откроется.
        }
        return new ProjectTrackerRow(
            basePath, project, null, Workspaces.Tracker.Read(layout), description, Version(file), Busy(layout), layout.NewerFormat);
    }

    /// <summary>
    /// Задачи трекера базы в работе — по памяти всех машин оператора, как занятые сценарии флоу (B-275): заголовок
    /// памяти начат именем трекера и номером задачи, как задачу трекера называет кит — «GitHub #37», «Jira PAY-7».
    /// Трекер не назван в описании — задач его нет.
    /// </summary>
    public static List<TrackerTask> Busy(BaseLayout layout)
    {
        if (Workspaces.Tracker.Read(layout) is not { } tracker)
            return [];
        var name = tracker.Name ?? NameOf(layout);
        if (name is null)
            return [];
        var pattern = new Regex(
            $@"^\s*{Regex.Escape(name)}\s*(#\d+|[A-Za-z][A-Za-z0-9_]*-\d+)(\s|$)", RegexOptions.IgnoreCase);
        return WorkspaceCollector.AllMemories(layout)
            .Where(e => e.Memory.Task is { } task && pattern.IsMatch(task))
            .Select(e => new TrackerTask(e.Memory.Task!, e.Memory.Copy))
            .OrderBy(t => t.Task, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Имя трекера из описания, которое строки «Бэклога» не назвали (сломанный сервер или проект).</summary>
    private static string? NameOf(BaseLayout layout)
    {
        try
        {
            var name = TrackerDescriptions.Parse(File.ReadAllText(layout.TrackerFile)).Tracker.Trim();
            return name.Length > 0 ? name : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Отпечаток tracker.md: sha-256 его байтов; файла нет — «».</summary>
    public static string Version(string file)
    {
        try
        {
            return File.Exists(file) ? Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(file))) : "";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return "?";
        }
    }

    /// <summary>Чем свести базу: sync.ps1 кита и копия проекта на диске, связанная с базой.</summary>
    private sealed record Sync(string Script, string Copy);

    /// <summary>Скрипт кита и копия, из которой он сводит базу; нет чего-то — null и отказ, который вернуть окну.</summary>
    private static Sync? SyncOf(BasesStore bases, BaseLayout layout, out IResult rejection)
    {
        rejection = Results.Ok();
        if (bases.Kit() is not { } kit)
            rejection = Results.Conflict(new ProjectTrackerRejected("kit-not-set"));
        else if (KitSync.ScriptFile(kit) is var script && !File.Exists(script))
            rejection = Results.Conflict(new ProjectTrackerRejected("kit-not-found", script));
        else if (WorkspaceCollector.NewCopySource(layout.Workspaces) is not { } copy)
            rejection = Results.Conflict(new ProjectTrackerRejected("no-copy"));
        else
            return new Sync(script, copy);
        return null;
    }

    /// <summary>
    /// Забирает базу с сервера, как кит перед записью описания, и сверяет tracker.md с тем, что видел оператор:
    /// иначе отдача после записи упёрлась бы в конфликт и остановила работу со знанием. Сервер недоступен — пишется
    /// в базу этой машины, как у кита. null — можно писать.
    /// </summary>
    private static async Task<IResult?> RefreshAsync(Sync sync, BaseLayout layout, string? version)
    {
        var pulled = await KitSync.RunAsync(sync.Script, sync.Copy, KitSync.Pull);
        if (!pulled.Done && pulled.Code != 2)
            return Results.Conflict(new ProjectTrackerRejected("pull", pulled.Message));
        if (Version(layout.TrackerFile) != (version ?? ""))
            return Results.Conflict(new ProjectTrackerRejected("changed"));
        if (await BaseGit.IsDirtyAsync(layout.Base, BaseLayout.TrackerName, CancellationToken.None) is not false)
            return Results.Conflict(new ProjectTrackerRejected("dirty"));
        return null;
    }

    /// <summary>
    /// Пишет tracker.md (null — удаляет) и коммитит его в git базы явным путём; null — прошло. Не прошло — файл
    /// возвращается как был и снимается с индекса. Начавшись, запись отменой запроса не рвётся.
    /// </summary>
    private static async Task<ProjectTrackerRejected?> CommitAsync(BaseLayout layout, byte[]? bytes, string message)
    {
        var root = layout.Base;
        var path = BaseLayout.TrackerName;
        var file = layout.TrackerFile;
        var before = File.Exists(file) ? await File.ReadAllBytesAsync(file) : null;
        var tracked = await BaseGit.TrackedAsync(root, path, CancellationToken.None);

        ProjectTrackerRejected? failure = null;
        try
        {
            Write(file, bytes);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            failure = new ProjectTrackerRejected("not-written", e.Message);
        }

        if (failure is null && bytes is not null && !tracked
            && (await BaseGit.AddFileAsync(root, path, CancellationToken.None)).Error is { } added)
            failure = new ProjectTrackerRejected("not-committed", added);

        // Файл, которого git не знал, удалён — коммитить нечего.
        if (failure is null && (bytes is not null || tracked)
            && (await BaseGit.CommitFileAsync(root, path, message, CancellationToken.None)).Error is { } refused)
            failure = new ProjectTrackerRejected("not-committed", refused);

        if (failure is null)
            return null;

        if (!tracked)
            await BaseGit.ResetFilesAsync(root, [path], CancellationToken.None);
        try
        {
            Write(file, before);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new ProjectTrackerRejected("not-restored", $"{failure.Detail} Описание трекера не вернулось: {e.Message}");
        }
        return failure;
    }

    private static void Write(string file, byte[]? bytes)
    {
        if (bytes is null)
        {
            File.Delete(file);
            return;
        }
        var temp = file + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, file, overwrite: true);
    }

    private static string? Configured(BasesStore bases, string? basePath)
    {
        if (basePath is null)
            return null;
        var configured = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, basePath));
        return configured is not null && Directory.Exists(configured) ? configured : null;
    }
}
