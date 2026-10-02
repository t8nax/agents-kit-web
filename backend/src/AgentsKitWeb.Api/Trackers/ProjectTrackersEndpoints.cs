using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>Задача трекера, которая идёт в рабочей копии: Task — заголовок её памяти, Copy — путь копии.</summary>
public sealed record TrackerTask(string Task, string? Copy);

/// <summary>
/// Проект раздела «Трекеры» — одна база из списка панели (B-293). Problem — база не читается (слова раскладки);
/// Tracker — трекер, как его читает «Бэклог» (null — описания нет); Description — описание полями окна; Version —
/// отпечаток tracker.md, поверх которого пишется правка («» — файла нет); Busy — задачи этого трекера в работе:
/// пока они есть, описание не удаляется; NewerFormat — база нового формата кита, правка закрыта (B-281); Faults — что
/// в описании сверка кита назовёт красным, по полям окна (ревью B-293); трекер не из таблицы кит только предупреждает.
/// </summary>
public sealed record ProjectTrackerRow(
    string Base,
    string Project,
    string? Problem,
    TrackerInfo? Tracker,
    TrackerDescription? Description,
    string Version,
    IReadOnlyList<TrackerTask> Busy,
    bool NewerFormat,
    IReadOnlyDictionary<string, string>? Faults = null);

/// <summary>
/// Запись описания. Key и Email — ключ к серверу YouTrack или Jira и почта, с которой ключ входит в Jira, введённые
/// в окне трекера (B-285): пустой ключ — оставить сохранённый. В базу они не попадают — только в ключи этого компьютера.
/// </summary>
public sealed record SaveProjectTrackerRequest(
    string? Base, string? Version, TrackerDescription? Description, string? Key = null, string? Email = null);

/// <summary>
/// Описание записано. Checked — панель проверила трекер чтением задач (у GitLab — нет); Pushed — база ушла
/// на сервер, иначе Message — слова кита, почему нет. Version — отпечаток записанного файла. KeyRemoved — с удалённым
/// описанием ушёл и ключ к серверу: других проектов на этом сервере нет (B-285).
/// </summary>
public sealed record ProjectTrackerSaved(string Version, bool Checked, bool Pushed, string? Message, bool KeyRemoved = false);

/// <summary>
/// Запись не прошла. Problem: newer-format — база нового формата кита; invalid — описание не в форме кита (Faults — по
/// полям окна, и email, key — почта и ключ к серверу); check — трекер не прочитан или ключ не принят (Field — поле, Code —
/// причина кодами задач «Бэклога», Detail — строка трекера); keys-broken — файл ключей этого компьютера не разобран
/// (Detail — его путь); changed — описание поменялось с тех пор, как его видел оператор; dirty — в tracker.md чужая
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
        app.MapGet("/api/trackers/projects", (BasesStore bases, StartedTasks started) =>
            bases.List().Select(basePath => Row(basePath, started)).ToList());

        app.MapPut("/api/trackers/projects", async (
            SaveProjectTrackerRequest request, BasesStore bases, ProjectTracker tracker, TrackerServersStore servers,
            TrackerFiltersStore filters, CancellationToken cancellationToken) =>
        {
            if (Configured(bases, request.Base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout
                || request.Description is not { } asked)
                return Results.NotFound();
            // Фильтр задач — уже не строка описания, а настройка панели на этом компьютере (B-285): в базу он не пишется.
            var description = asked with { Filter = "" };
            if (layout.NewerFormat)
                return Results.Conflict(new ProjectTrackerRejected("newer-format", BaseLayout.NewerFormatRefusal));

            // Форму кита панель держит сама: файл, который сверка кита назовёт красным, в базу не уходит.
            if (TrackerDescriptions.Faults(description) is { Count: > 0 } faults)
                return Results.BadRequest(new ProjectTrackerRejected("invalid", Faults: faults));

            // Ключ к серверу — в окне трекера, у тех трекеров, которым он нужен (ответ оператора на B-285).
            var parsed = Workspaces.Tracker.Parse(TrackerDescriptions.Serialize(description, "Проверка"));
            if (KeyOf(request, parsed, servers, out var typed) is { } keyFaults)
                return Results.BadRequest(new ProjectTrackerRejected("invalid", Faults: keyFaults));
            // Ключ пишется после коммита описания: битый файл ключей должен остановить запись до неё (ревью B-288 — его не перезаписывают).
            if (typed is not null)
                try
                {
                    servers.List();
                }
                catch (TrackersFileBroken broken)
                {
                    return Results.Conflict(new ProjectTrackerRejected("keys-broken", broken.File));
                }

            if (SyncOf(bases, layout, out var unready) is not { } sync)
                return unready;

            if (await RefreshAsync(sync, layout, request.Version) is { } stale)
                return stale;

            // Введённый ключ сохраняется, только когда сервер назвал его владельца — решение оператора на B-288.
            string? owner = null;
            if (typed is not null)
            {
                var who = await tracker.OwnerAsync(parsed.Kind, parsed.Server!, typed, cancellationToken);
                if (who.Login is not { } login)
                    return Results.UnprocessableEntity(new ProjectTrackerRejected(
                        "check", who.Detail, Field: who.Problem == TrackerIssues.ServerSilent ? "server" : "key",
                        Code: who.Problem ?? (parsed.Kind == TrackerInfo.Jira ? TrackerIssues.JiraError : TrackerIssues.YouTrackError)));
                owner = login;
            }

            // Проверка трекера — решение оператора на B-293: описание, по которому задач не прочитать, не пишется.
            var check = await tracker.CheckAsync(description, cancellationToken, typed);
            if (!check.Passed)
                return Results.UnprocessableEntity(
                    new ProjectTrackerRejected("check", check.Detail, Field: check.Field, Code: check.Problem));

            // Проверка трекера ходит в сеть секундами: правку, которую за это время записала сессия, панель не перепишет.
            if (Version(layout.TrackerFile) != (request.Version ?? "")
                || await BaseGit.IsDirtyAsync(layout.Base, BaseLayout.TrackerName, CancellationToken.None) is not false)
                return Results.Conflict(new ProjectTrackerRejected("changed"));

            var before = File.Exists(layout.TrackerFile) ? await File.ReadAllBytesAsync(layout.TrackerFile, CancellationToken.None) : null;
            // Строка «фильтр:», которую запись уберёт из описания, переезжает в фильтр проекта, если он ещё не задан.
            var previous = Workspaces.Tracker.Read(layout);
            var described = previous?.Filter;
            var bytes = Bytes(description, ProjectName.Of(basePath), before);
            // То же описание байт в байт — коммитить нечего, оно уже записано; базу панель всё равно отдаёт.
            if (before is null || !bytes.AsSpan().SequenceEqual(before))
                if (await CommitAsync(layout, bytes, CommitMessage) is { } failure)
                    return Results.Json(failure, statusCode: StatusCodes.Status502BadGateway);

            // Ключ — только когда описание записано: иначе отвергнутая правка оставила бы новый ключ общим проектам сервера.
            if (typed is not null)
                servers.Save(parsed.Server!, owner!, typed.Key, typed.Email);
            // Проект ушёл с прежнего сервера, а других проектов там нет — ключ к нему показать негде, он уходит, как при
            // удалении трекера (ревью B-285).
            if (previous is { Server: { } was } && ProjectTracker.NeedsKey(previous.Kind)
                && !(ProjectTracker.NeedsKey(parsed.Kind) && parsed.Server is { } now && TrackerServersStore.SameServer(was, now))
                && !OthersOnServer(bases, basePath, was))
                RemoveKey(servers, was);
            try
            {
                // Трекер сменил вид — строка поиска прежнего ему не годится, и фильтр проекта снимается (ревью B-285)
                if (previous is not null && previous.Kind != parsed.Kind)
                    filters.Remove(basePath);
                else
                    filters.Keep(basePath, described);
            }
            catch (FiltersFileBroken)
            {
                // Битый файл фильтров не перезаписывается; описание уже записано, а фильтр оператор задаст на вкладке.
            }

            var pushed = await KitSync.RunAsync(sync.Script, sync.Copy, KitSync.Push);
            return Results.Ok(new ProjectTrackerSaved(
                Version(layout.TrackerFile), check.Checked, pushed.Done, pushed.Done ? null : pushed.Message));
        });

        app.MapDelete("/api/trackers/projects", async (
            string? @base, string? version, BasesStore bases, StartedTasks started, TrackerServersStore servers,
            TrackerFiltersStore filters, CancellationToken cancellationToken) =>
        {
            if (Configured(bases, @base) is not { } basePath || BaseLayout.Read(basePath) is not { } layout)
                return Results.NotFound();
            if (layout.NewerFormat)
                return Results.Conflict(new ProjectTrackerRejected("newer-format", BaseLayout.NewerFormatRefusal));

            // Удалить нельзя, пока идёт задача из этого трекера: сессии нечем было бы её закрыть — ответ оператора на B-293.
            if (Busy(layout, started) is { Count: > 0 } busy)
                return Results.Conflict(new ProjectTrackerRejected("busy", Busy: busy));

            if (SyncOf(bases, layout, out var unready) is not { } sync)
                return unready;

            if (await RefreshAsync(sync, layout, version) is { } stale)
                return stale;
            // Пока база сводилась с сервером, в копии могла начаться задача этого трекера.
            if (Busy(layout, started) is { Count: > 0 } arrived)
                return Results.Conflict(new ProjectTrackerRejected("busy", Busy: arrived));
            if (!File.Exists(layout.TrackerFile))
                return Results.Conflict(new ProjectTrackerRejected("changed"));

            var removed = Workspaces.Tracker.Read(layout);
            if (await CommitAsync(layout, null, DeleteMessage) is { } failure)
                return Results.Json(failure, statusCode: StatusCodes.Status502BadGateway);

            // Ключ к серверу без проектов показать негде: он уходит вместе с последним трекером на сервере (B-285).
            var keyRemoved = removed is { Server: { } server } && ProjectTracker.NeedsKey(removed.Kind)
                && !OthersOnServer(bases, basePath, server) && RemoveKey(servers, server);
            // Без трекера отбирать нечего: фильтр проекта уходит вместе с ним (ревью B-285)
            try
            {
                filters.Remove(basePath);
            }
            catch (FiltersFileBroken)
            {
                // Битый файл фильтров не перезаписывается; описание уже удалено.
            }

            var pushed = await KitSync.RunAsync(sync.Script, sync.Copy, KitSync.Push);
            return Results.Ok(new ProjectTrackerSaved("", false, pushed.Done, pushed.Done ? null : pushed.Message, keyRemoved));
        });
    }

    /// <summary>
    /// Ключ из окна трекера. Трекер без ключа (GitHub, GitLab) — null без отказа. Пустой ключ — оставить сохранённый:
    /// typed — null. Отказ — по полям окна: Jira без почты не впустит, а сменённую почту проверить нечем без ключа.
    /// </summary>
    private static Dictionary<string, string>? KeyOf(
        SaveProjectTrackerRequest request, TrackerInfo tracker, TrackerServersStore servers, out ServerKey? typed)
    {
        typed = null;
        if (!ProjectTracker.NeedsKey(tracker.Kind) || tracker.Server is not { } server)
            return null;
        var jira = tracker.Kind == TrackerInfo.Jira;
        var key = (request.Key ?? "").Trim();
        var email = (request.Email ?? "").Trim();
        if (jira && email.Length == 0)
            return new() { ["email"] = "Укажите почту, с которой вы входите в Jira." };
        if (key.Length > 0)
        {
            typed = new ServerKey(key, jira ? email : null);
            return null;
        }
        string? stored;
        try
        {
            stored = servers.Find(server).Email;
        }
        catch (TrackersFileBroken)
        {
            stored = null;
        }
        return jira && stored is not null && !string.Equals(stored, email, StringComparison.OrdinalIgnoreCase)
            ? new() { ["key"] = "Почта изменилась — введите ключ заново." }
            : null;
    }

    /// <summary>Есть ли среди баз панели, кроме этой, проект с трекером, ключ к которому нужен, на том же сервере.</summary>
    private static bool OthersOnServer(BasesStore bases, string basePath, string server) =>
        bases.List()
            .Where(b => !BasesStore.SamePath(b, basePath))
            .Select(b => BaseLayout.Read(b) is { } layout ? Workspaces.Tracker.Read(layout) : null)
            .Any(t => t is { Server: { } other } && ProjectTracker.NeedsKey(t.Kind) && TrackerServersStore.SameServer(other, server));

    private static bool RemoveKey(TrackerServersStore servers, string server)
    {
        try
        {
            return servers.Remove(server);
        }
        catch (TrackersFileBroken)
        {
            return false;
        }
    }

    /// <summary>
    /// Байты tracker.md: описание в форме кита, а переводы строк, BOM, заголовок «# …», текст над разделами и разделы не
    /// из таблицы — как у прежнего файла:
    /// иначе каждая правка переписывала бы в истории базы весь файл (ревью B-293). Файла не было — LF, без BOM,
    /// заголовок по имени проекта, как у кита.
    /// </summary>
    public static byte[] Bytes(TrackerDescription description, string project, byte[]? before)
    {
        var bom = before is [0xEF, 0xBB, 0xBF, ..];
        var old = before is null ? null : new UTF8Encoding(false).GetString(before, bom ? 3 : 0, before.Length - (bom ? 3 : 0));
        var text = TrackerDescriptions.Serialize(description, project, old is null ? null : TrackerDescriptions.Frame(old));
        if (old is not null && old.Contains("\r\n"))
            text = text.Replace("\n", "\r\n");
        var bytes = Encoding.UTF8.GetBytes(text);
        return bom ? [0xEF, 0xBB, 0xBF, .. bytes] : bytes;
    }

    /// <summary>Строка карточки по базе из списка панели.</summary>
    public static ProjectTrackerRow Row(string basePath, StartedTasks? started = null)
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
            basePath, project, null, Workspaces.Tracker.Read(layout), description, Version(file), Busy(layout, started), layout.NewerFormat,
            description is null ? null : KitFaults(description));
    }

    /// <summary>
    /// Задачи трекера базы в работе — по памяти всех машин оператора (B-275): заголовок
    /// памяти начат именем трекера и номером задачи, как задачу трекера называет кит — «GitHub #37», «Jira PAY-7».
    /// Трекер не назван в описании — задач его нет. Задача, которую панель запускает и памяти у которой ещё нет,
    /// держит описание так же (ревью B-293).
    /// </summary>
    public static List<TrackerTask> Busy(BaseLayout layout, StartedTasks? started = null)
    {
        if (TrackerDescriptions.NameOf(layout) is not { } name)
            return [];
        var pattern = new Regex(
            $@"^\s*{Regex.Escape(name)}\s*(#\d+|[A-Za-z][A-Za-z0-9_]*-\d+)(\s|$)", RegexOptions.IgnoreCase);
        var launching = (started?.OfBase(layout.Base) ?? [])
            .Where(s => pattern.IsMatch(s.Task))
            .Select(s => new TrackerTask(s.Task, s.Copy));
        return WorkspaceCollector.AllMemories(layout)
            .Where(e => e.Memory.Task is { } task && pattern.IsMatch(task))
            .Select(e => new TrackerTask(e.Memory.Task!, FullPath(e.Memory.Copy)))
            .Concat(launching)
            .DistinctBy(t => (t.Copy is null ? "" : WorkspaceCollector.Normalize(t.Copy), taskNumber(t.Task)))
            .OrderBy(t => t.Task, StringComparer.Ordinal)
            .ToList();

        string taskNumber(string task) => pattern.Match(task) is { Success: true } m ? m.Groups[1].Value.ToUpperInvariant() : task;
    }

    /// <summary>
    /// Поломки описания, которые сверка кита назовёт красными. Трекер не из таблицы кит только предупреждает: такой
    /// строки нет, пока его имя названо.
    /// </summary>
    private static Dictionary<string, string> KitFaults(TrackerDescription description)
    {
        var faults = TrackerDescriptions.Faults(description);
        if (description.Tracker.Trim().Length > 0)
            faults.Remove("tracker");
        // Строки ключей для кита — уже непустой раздел «Где задачи»; слов под ними требует только панель при записи.
        if (new[] { description.Tracker, description.Server, description.Project }.Any(v => v.Trim().Length > 0))
            faults.Remove("where");
        // Строку «фильтр:» сверка кита не судит вовсе: её держит панель при записи (B-300).
        faults.Remove("filter");
        return faults;
    }

    /// <summary>Путь копии из памяти — полным, как его приводит таблица копий: «a\..\b» — та же копия, что «b».</summary>
    private static string? FullPath(string? copy)
    {
        if (copy is null)
            return null;
        try
        {
            return Path.GetFullPath(copy);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return copy;
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
