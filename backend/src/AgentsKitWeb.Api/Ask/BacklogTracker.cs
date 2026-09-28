using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Задача трекера, какой её заведёт перенос записи. Title — заголовок записи без номера, Body — текст записи
/// оператору, её «Агенту» и ссылки на сайты из «Артефактов», как по раскладке кита («Вынести в трекер»). Files —
/// файлы artifacts/ записи: к задаче их панель не прикладывает, и они уходят из базы вместе с записью.
/// Original — запись, как её видел оператор: по ней перенос узнаёт, что запись успели поменять.
/// </summary>
public sealed record TrackerDraft(string Number, string Title, string Body, IReadOnlyList<TaskArtifact> Files, string Original);

public sealed record TrackerMoveRequest(string? Base, string? Number, string? Original);

/// <summary>
/// Чем кончился перенос записи в трекер. Problem — задача не заведена: как у TrackerIssues и CreatedIssue, Detail —
/// строка трекера. Error без Issue — перенос не начат (чужая правка бэклога, запись изменилась); Error с Issue —
/// задача заведена, а запись осталась в бэклоге. Commit — коммит, которым запись ушла из бэклога, Removed — файлы
/// artifacts/, ушедшие вместе с ней. Problem «entry-changed» — запись изменилась после открытия окна: окно читает её заново.
/// </summary>
public sealed record TrackerMoved(
    TrackerIssue? Issue,
    string? Problem = null,
    string? Detail = null,
    string? Error = null,
    string? Output = null,
    string? Commit = null,
    IReadOnlyList<string>? Removed = null)
{
    public const string EntryChanged = "entry-changed";
}

/// <summary>
/// Перенос записи бэклога в трекер проекта — B-286 и B-288: задачу заводит gh оператора в GitHub или панель своим
/// клиентом в YouTrack, запись вырезает панель тем же путём, что «Сохранить» разговора с Чудо-Юдо. Трекер —
/// из строк описания трекера (Trackers/ProjectTracker), других трекеров, кроме GitHub и YouTrack, панель не знает.
/// </summary>
public static partial class BacklogTracker
{
    public const string WhoseMove = "открытия окна переноса";

    /// <summary>
    /// Задача из записи, как она лежит в файле: заголовок, поля и разделы — по раскладке кита. declared — поля,
    /// объявленные шапкой файла: только они отсекаются, как их отсекает разбор записи (ревью B-286).
    /// </summary>
    public static TrackerDraft Draft(string number, string original, IReadOnlyCollection<string> declared)
    {
        var lines = original.Split('\n');
        var heading = lines[0].StartsWith("## ") ? lines[0][3..].Trim() : lines[0].Trim();
        var title = NumberedTitle.Match(heading) is { Success: true } match ? match.Groups["title"].Value.Trim() : heading;

        var body = new List<string>();
        var files = new List<TaskArtifact>();
        var links = new List<string>();
        string? section = null;
        var beforeText = true;
        foreach (var line in lines.Skip(1))
        {
            if (line.StartsWith("### "))
            {
                Flush();
                section = line[4..].Trim();
                if (section != Backlog.ArtifactsSection)
                    body.Add(line);
                continue;
            }
            // Поля записи — тип и приоритет — в задачу не уходят: у трекера свои.
            if (beforeText && section is null && (line.Trim().Length == 0 || Backlog.IsField(line, declared)))
                continue;
            beforeText = false;
            if (section == Backlog.ArtifactsSection)
            {
                if (WorkMemory.Artifact(line) is not { } artifact)
                    continue;
                if (IsLink(artifact.Address))
                    links.Add(line);
                else
                    files.Add(artifact);
                continue;
            }
            body.Add(line);
        }
        Flush();

        return new TrackerDraft(number, title, Trim(body), files, original);

        // Раздел «Артефакты» остаётся в описании, только если в нём есть ссылки на сайты: файлы в задачу не уходят.
        void Flush()
        {
            if (section == Backlog.ArtifactsSection && links.Count > 0)
                body.AddRange([$"### {Backlog.ArtifactsSection}", .. links, ""]);
            links.Clear();
        }
    }

    /// <summary>
    /// Что стало с задачей, которую трекер не завёл или завёл без номера, — одной фразой для оператора. Тексты живут
    /// только здесь: и окно переноса, и разговор с Чудо-Юдо показывают их как есть (ревью B-286). whose — чья задача:
    /// «Задача» у окна, «Задача для B-N» у разговора.
    /// </summary>
    public static string NotCreated(CreatedIssue created, string whose, TrackerInfo tracker)
    {
        const string settings = "в «Настройках», в карточке «Серверы трекеров»";
        var youTrack = tracker.Kind == TrackerInfo.YouTrack;
        var reason = created.Problem switch
        {
            TrackerIssues.GhMissing => "программа gh не установлена — установите GitHub CLI и войдите командой gh auth login",
            TrackerIssues.GhLogin => "программа gh не вошла в аккаунт GitHub — войдите командой gh auth login",
            TrackerIssues.RepoUnreachable =>
                "GitHub не нашёл репозиторий или у вашего аккаунта нет к нему доступа" + (created.Detail is null ? "" : $": {created.Detail}"),
            CreatedIssue.GitHubSilent => "GitHub не ответил за минуту",
            TrackerIssues.NoKey => $"для сервера {tracker.Server} нет ключа — добавьте его {settings}",
            TrackerIssues.KeyRejected => $"сервер {tracker.Server} отклонил ключ — замените его {settings}",
            TrackerIssues.KeyForbidden =>
                $"у владельца ключа нет прав заводить задачи в проекте {tracker.Project} — проверьте его права в YouTrack"
                + (created.Detail is null ? "" : $" ({created.Detail})"),
            TrackerIssues.ServerSilent => $"сервер {tracker.Server} не ответил: {created.Detail ?? "нет связи"}",
            TrackerIssues.ProjectMissing => $"на сервере {tracker.Server} нет проекта {tracker.Project} или у вашего ключа нет к нему доступа",
            CreatedIssue.YouTrackSilent => $"YouTrack не ответил за минуту{(created.Detail is null ? "" : $" ({created.Detail})")}",
            CreatedIssue.CreatedUnknown => youTrack ? "YouTrack не назвал номер задачи" : "gh не назвала адрес задачи",
            var other => $"{(youTrack ? "YouTrack" : "GitHub")} ответил ошибкой: {created.Detail ?? other}",
        };
        // Задача могла завестись: «не заведена» подтолкнуло бы завести её снова и получить дубль.
        return created.MaybeCreated
            ? $"{whose}, возможно, заведена: {reason}. Проверьте трекер, прежде чем пробовать снова"
            : $"{whose} не заведена: {reason}";
    }

    public static bool IsLink(string address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    /// <summary>
    /// Кнопка «В трекер»: сначала проверка, что запись можно вырезать, потом задача в трекере, потом вырез и коммит.
    /// Задача, заведённая под запись, которую не вырезать, осталась бы дублем, поэтому проверка идёт до трекера.
    /// </summary>
    public static async Task<TrackerMoved> MoveAsync(ProjectTracker trackers, string basePath, TrackerInfo tracker, TrackerDraft draft, BacklogEntry entry)
    {
        var proposal = new BacklogProposal(
            Guid.NewGuid().ToString("N"),
            [new BacklogChange(BacklogChange.Track, draft.Number, entry) { Original = draft.Original }]);
        var personal = BaseLayout.PersonalOf(basePath);
        await Writing.WaitAsync();
        try
        {
            // База нового формата кита: правка бэклога закрыта, и задача под запись, которую не вырезать, не заводится (B-281)
            if (BaseLayout.Read(basePath)?.NewerFormat == true)
                return new TrackerMoved(null, Error: BaseLayout.NewerFormatRefusal);
            if (await BacklogConversations.UnwritableAsync(personal, proposal, WhoseMove) is { } refusal)
                return new TrackerMoved(null, refusal.Changed ? TrackerMoved.EntryChanged : null, Error: refusal.Text);

            var created = await trackers.CreateAsync(tracker, draft.Title, draft.Body);
            if (created.Issue is not { } issue)
                return new TrackerMoved(null, created.Problem, created.Detail, NotCreated(created, "Задача", tracker));

            var saved = await BacklogConversations.WriteAsync(personal, proposal, [], WhoseMove);
            return saved.Error is { } error
                ? new TrackerMoved(issue, Error: error, Output: saved.Output)
                : new TrackerMoved(issue, Commit: saved.Commit, Removed: saved.Removed);
        }
        finally
        {
            Writing.Release();
        }
    }

    /// <summary>
    /// Запись бэклога из панели — перенос кнопкой и «Сохранить» разговора — идёт по одной: между проверкой записи
    /// и её вырезом трекер заводит задачу до минуты, и два переноса одной записи иначе завели бы две задачи (ревью B-286).
    /// </summary>
    internal static readonly SemaphoreSlim Writing = new(1, 1);

    public static void MapBacklogTrackerEndpoints(this IEndpointRouteBuilder app)
    {
        // Что уйдёт в трекер — окно показывает до подтверждения, и собирает это API, а не окно: описание задачи
        // должно быть тем, что заведёт перенос.
        app.MapGet("/api/backlog/tracker/draft", (string @base, string number, BasesStore bases) =>
            Find(bases, @base, number) switch
            {
                (null, _, var status) => Results.StatusCode(status),
                var (draft, _, _) => Results.Ok(draft),
            });

        app.MapPost("/api/backlog/tracker/move", async (TrackerMoveRequest request, BasesStore bases, ProjectTracker trackers) =>
        {
            if (request.Base is null || request.Number is null || request.Original is null)
                return Results.BadRequest();
            var (draft, found, status) = Find(bases, request.Base, request.Number);
            if (draft is null)
                return Results.StatusCode(status);
            // Окно подтверждало запись, какой её видело: изменилась — переносится не то, что видел оператор.
            if (draft.Original != request.Original.ReplaceLineEndings("\n"))
                return Results.Ok(new TrackerMoved(null, TrackerMoved.EntryChanged, Error: $"Запись {draft.Number} изменилась после {WhoseMove} — ничего не записано"));
            return Results.Ok(await MoveAsync(trackers, found!.Value.Base, found.Value.Tracker, draft, found.Value.Entry));
        });
    }

    private static (TrackerDraft? Draft, (string Base, TrackerInfo Tracker, BacklogEntry Entry)? Found, int Status) Find(
        BasesStore bases, string @base, string number)
    {
        var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, @base));
        if (basePath is null || BaseLayout.Read(basePath) is not { } layout || !File.Exists(layout.BacklogFile))
            return (null, null, StatusCodes.Status404NotFound);
        if (ProjectTracker.Movable(layout) is not { } tracker)
            return (null, null, StatusCodes.Status409Conflict);

        var normalized = BacklogNumber.Normalize(number);
        string text;
        try
        {
            text = File.ReadAllText(layout.BacklogFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return (null, null, StatusCodes.Status404NotFound);
        }
        var block = normalized is null ? null : Backlog.Blocks(text).FirstOrDefault(b => b.Number == normalized);
        var entry = normalized is null ? null : Backlog.Parse(text).FirstOrDefault(e => e.Number == normalized);
        if (block is null || entry is null)
            return (null, null, StatusCodes.Status404NotFound);
        return (Draft(normalized!, block.Text, Backlog.Declared(text)), (basePath, tracker, entry), StatusCodes.Status200OK);
    }

    private static string Trim(List<string> lines)
    {
        var text = string.Join("\n", lines).Trim('\n');
        return Regex.Replace(text, @"\n{3,}", "\n\n");
    }

    [GeneratedRegex(@"^(?<number>\S+)\s+(?<title>.+)$")]
    private static partial Regex NumberedTitle { get; }
}
