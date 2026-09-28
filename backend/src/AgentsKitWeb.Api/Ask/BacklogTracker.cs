using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Задача трекера, какой её заведёт перенос записи. Title — заголовок записи без номера, Body — текст записи
/// оператору, её «Агенту» и ссылки на сайты из «Артефактов», как по раскладке кита («Вынести в трекер»). Files —
/// файлы artifacts/ записи: приложить их к задаче gh не умеет, и они уходят из базы вместе с записью.
/// Original — запись, как её видел оператор: по ней перенос узнаёт, что запись успели поменять.
/// </summary>
public sealed record TrackerDraft(string Number, string Title, string Body, IReadOnlyList<TaskArtifact> Files, string Original);

public sealed record TrackerMoveRequest(string? Base, string? Number, string? Original);

/// <summary>
/// Чем кончился перенос записи в трекер. Problem — задача не заведена: как у TrackerIssues и CreatedIssue, Detail —
/// строка GitHub. Error без Issue — перенос не начат (чужая правка бэклога, запись изменилась); Error с Issue —
/// задача заведена, а запись осталась в бэклоге. Commit — коммит, которым запись ушла из бэклога.
/// </summary>
public sealed record TrackerMoved(
    TrackerIssue? Issue,
    string? Problem = null,
    string? Detail = null,
    string? Error = null,
    string? Output = null,
    string? Commit = null);

/// <summary>
/// Перенос записи бэклога в трекер проекта — B-286: задачу заводит gh оператора, запись вырезает панель тем же
/// путём, что «Сохранить» разговора с Чудо-Юдо. Только GitHub с адресом репозитория в tracker.md.
/// </summary>
public static partial class BacklogTracker
{
    public const string WhoseMove = "открытия окна переноса";

    /// <summary>Задача из записи, как она лежит в файле: заголовок, поля и разделы — по раскладке кита.</summary>
    public static TrackerDraft Draft(string number, string original)
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
            if (beforeText && section is null && (line.Trim().Length == 0 || FieldLine.IsMatch(line)))
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
    /// Что стало с задачей, которую gh не завела или завела без адреса, — одной фразой для оператора. Тексты живут
    /// только здесь: и окно переноса, и разговор с Чудо-Юдо показывают их как есть (ревью B-286). whose — чья задача:
    /// «Задача» у окна, «Задача для B-N» у разговора.
    /// </summary>
    public static string NotCreated(CreatedIssue created, string whose)
    {
        var reason = created.Problem switch
        {
            TrackerIssues.GhMissing => "программа gh не установлена — установите GitHub CLI и войдите командой gh auth login",
            TrackerIssues.GhLogin => "программа gh не вошла в аккаунт GitHub — войдите командой gh auth login",
            TrackerIssues.RepoUnreachable =>
                "GitHub не нашёл репозиторий или у вашего аккаунта нет к нему доступа" + (created.Detail is null ? "" : $": {created.Detail}"),
            CreatedIssue.GitHubSilent => "GitHub не ответил за минуту",
            CreatedIssue.CreatedUnknown => "gh не назвала адрес задачи",
            var other => $"GitHub ответил ошибкой: {created.Detail ?? other}",
        };
        // Задача могла завестись: «не заведена» подтолкнуло бы завести её снова и получить дубль.
        return created.MaybeCreated
            ? $"{whose}, возможно, заведена: {reason}. Проверьте трекер, прежде чем пробовать снова"
            : $"{whose} не заведена: {reason}";
    }

    public static bool IsLink(string address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    /// <summary>Репозиторий трекера базы; null — трекер у проекта не GitHub с адресом, и переносить некуда.</summary>
    public static string? RepoOf(BaseLayout layout) =>
        Tracker.Read(layout) is { Kind: TrackerInfo.GitHub, Repo: { } repo } ? repo : null;

    /// <summary>
    /// Кнопка «В трекер»: сначала проверка, что запись можно вырезать, потом задача в GitHub, потом вырез и коммит.
    /// Задача, заведённая под запись, которую не вырезать, осталась бы дублем, поэтому проверка идёт до GitHub.
    /// </summary>
    public static async Task<TrackerMoved> MoveAsync(IGitHubIssues github, string personal, string repo, TrackerDraft draft, BacklogEntry entry)
    {
        var proposal = new BacklogProposal(
            Guid.NewGuid().ToString("N"),
            [new BacklogChange(BacklogChange.Track, draft.Number, entry) { Original = draft.Original }]);
        if (await BacklogConversations.UnwritableAsync(personal, proposal, WhoseMove) is { } refusal)
            return new TrackerMoved(null, Error: refusal);

        var created = await github.CreateAsync(repo, draft.Title, draft.Body);
        if (created.Issue is not { } issue)
            return new TrackerMoved(null, created.Problem, created.Detail, NotCreated(created, "Задача"));

        var saved = await BacklogConversations.WriteAsync(personal, proposal, [], WhoseMove);
        return saved.Error is { } error
            ? new TrackerMoved(issue, Error: error, Output: saved.Output)
            : new TrackerMoved(issue, Commit: saved.Commit);
    }

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

        app.MapPost("/api/backlog/tracker/move", async (TrackerMoveRequest request, BasesStore bases, IGitHubIssues github) =>
        {
            if (request.Base is null || request.Number is null || request.Original is null)
                return Results.BadRequest();
            var (draft, found, status) = Find(bases, request.Base, request.Number);
            if (draft is null)
                return Results.StatusCode(status);
            // Окно подтверждало запись, какой её видело: изменилась — переносится не то, что видел оператор.
            if (draft.Original != request.Original.ReplaceLineEndings("\n"))
                return Results.Ok(new TrackerMoved(null, Error: $"Запись {draft.Number} изменилась после {WhoseMove} — ничего не записано"));
            return Results.Ok(await MoveAsync(github, found!.Value.Personal, found.Value.Repo, draft, found.Value.Entry));
        });
    }

    private static (TrackerDraft? Draft, (string Personal, string Repo, BacklogEntry Entry)? Found, int Status) Find(
        BasesStore bases, string @base, string number)
    {
        var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, @base));
        if (basePath is null || BaseLayout.Read(basePath) is not { } layout || !File.Exists(layout.BacklogFile))
            return (null, null, StatusCodes.Status404NotFound);
        if (RepoOf(layout) is not { } repo)
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
        return (Draft(normalized!, block.Text), (layout.Personal, repo, entry), StatusCodes.Status200OK);
    }

    private static string Trim(List<string> lines)
    {
        var text = string.Join("\n", lines).Trim('\n');
        return Regex.Replace(text, @"\n{3,}", "\n\n");
    }

    [GeneratedRegex(@"^(?<number>\S+)\s+(?<title>.+)$")]
    private static partial Regex NumberedTitle { get; }

    [GeneratedRegex(@"^(приоритет|тип):\s")]
    private static partial Regex FieldLine { get; }
}
