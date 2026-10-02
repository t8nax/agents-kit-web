using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>
/// Владелец ключа Jira: AccountId — по нему отмечаются свои задачи и назначается заведённая, Name — почта, а без неё
/// имя, его видит оператор. Problem задан — сервер владельца не назвал, значения те же, что у TrackerIssues.
/// </summary>
public sealed record JiraUser(string? AccountId, string? Name, string? Problem = null, string? Detail = null);

public interface IJira
{
    /// <summary>Кому принадлежит ключ: им проверяется ключ при сохранении трекера проекта.</summary>
    Task<JiraUser> WhoAsync(string server, string email, string key, CancellationToken cancellationToken);

    /// <summary>
    /// Незакрытые задачи проекта, все, чьи бы ни были, как у GitHub и YouTrack (AKW-17); filter — строка JQL,
    /// дописанная к запросу, null — без отбора. Mine — у задач, назначенных на владельца ключа.
    /// </summary>
    Task<TrackerIssues> OpenAsync(
        string server, string email, string key, string project, string? filter, CancellationToken cancellationToken);
}

/// <summary>
/// Облачную Jira панель читает сама, по REST v3 с почтой и API-токеном оператора (вход Basic) — решения оператора
/// на B-285: серверная Jira не входит. Незакрытая задача — без решения и со статусом не из группы «Готово»: своего
/// статуса «Готово» в проекте может не быть, а группа есть у любого статуса, и решение ставят не во всех проектах.
/// </summary>
public sealed class JiraApi(IHttpClientFactory clients) : IJira
{
    public const string Client = "jira";

    // Чтение ждёт недолго: раздел не должен висеть на открытии.
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(15);

    public async Task<JiraUser> WhoAsync(string server, string email, string key, CancellationToken cancellationToken)
    {
        var reply = await SendAsync(Get(server, email, key, "rest/api/3/myself"), ReadTimeout, cancellationToken);
        if (reply.Problem is not null)
            return new JiraUser(null, null, reply.Problem, reply.Detail);
        if (Text(reply.Json, "accountId") is not { Length: > 0 } accountId)
            return new JiraUser(null, null, TrackerIssues.JiraError, NotJira);
        return new JiraUser(accountId,
            Text(reply.Json, "emailAddress") is { Length: > 0 } address ? address : Text(reply.Json, "displayName") ?? email);
    }

    /// <summary>
    /// Проект спрашивается до поиска: JQL с несуществующим проектом Jira отвергает так же, как неверный фильтр (400),
    /// и без этого «проект не найден» назвался бы «Jira не приняла фильтр». Владелец ключа спрашивается рядом:
    /// по нему отмечаются свои задачи; не узнали — своих не отмечено.
    /// </summary>
    public async Task<TrackerIssues> OpenAsync(
        string server, string email, string key, string project, string? filter, CancellationToken cancellationToken)
    {
        var me = WhoAsync(server, email, key, cancellationToken);
        var found = await ProjectAsync(server, email, key, project, cancellationToken);
        var who = await me;
        // Отклонённые почта или ключ — причина раньше ответа о проекте: на чужой ключ сервер может отвечать по проекту
        // «не найден», и «Бэклог» повёл бы оператора в поле проекта, а не ключа (ревью B-285).
        if (who.Problem == TrackerIssues.KeyRejected)
            return new TrackerIssues([], who.Problem, who.Detail);
        if (found.Problem is not null)
            return new TrackerIssues([], found.Problem, found.Detail);

        var jql = $"project = \"{found.Key}\" AND resolution = EMPTY AND statusCategory != Done";
        // Фильтр — в скобках: AND в JQL связывает сильнее OR, и «status = A OR status = B» без скобок вернул бы
        // закрытые задачи и задачи других проектов.
        if (!string.IsNullOrWhiteSpace(filter))
            jql += $" AND ({filter.Trim()})";
        jql += " ORDER BY created DESC";

        // Страница поиска бывает меньше запрошенной — Jira урезает её сама; листается, пока не набралось на одну
        // больше предела или задачи не кончились.
        var issues = new List<TrackerIssue>();
        string? token = null;
        do
        {
            var path = $"rest/api/3/search/jql?jql={Uri.EscapeDataString(jql)}&fields=summary,assignee"
                + $"&maxResults={TrackerIssues.Limit + 1 - issues.Count}"
                + (token is null ? "" : $"&nextPageToken={Uri.EscapeDataString(token)}");
            var reply = await SendAsync(Get(server, email, key, path), ReadTimeout, cancellationToken);
            // Проект найден и ключ принят — поиск с фильтром, отвергнутый как неверный запрос (400), значит, что Jira
            // не приняла строку фильтра; сбой сервера (5xx) фильтр не винит.
            if (reply.Status == HttpStatusCode.BadRequest && !string.IsNullOrWhiteSpace(filter))
                return new TrackerIssues([], TrackerIssues.FilterRejected, reply.Detail);
            if (reply.Problem is not null)
                return new TrackerIssues([], reply.Problem, reply.Detail);
            if (reply.Json?["issues"] is not JsonArray page)
                return new TrackerIssues([], TrackerIssues.JiraError, NotJira);
            issues.AddRange(page.OfType<JsonObject>()
                .Select(i => Issue(server, Text(i, "key"), Text(i["fields"], "summary") ?? "") is { } issue
                    ? Assigned(issue, i["fields"]?["assignee"], who.AccountId)
                    : null)
                .OfType<TrackerIssue>());
            token = reply.Json["isLast"] is JsonValue last && last.TryGetValue<bool>(out var isLast) && isLast
                ? null
                : Text(reply.Json, "nextPageToken");
            if (page.Count == 0)
                break;
        }
        while (token is not null && issues.Count <= TrackerIssues.Limit);
        return TrackerIssues.Read(issues);
    }

    /// <summary>Исполнитель у задачи Jira один — его имя; нет его — задача ничья. Своя — его accountId у владельца ключа.</summary>
    private static TrackerIssue Assigned(TrackerIssue issue, JsonNode? assignee, string? me)
    {
        var name = Text(assignee, "displayName") is { Length: > 0 } shown ? shown : null;
        return issue with
        {
            Assignee = name,
            Mine = me is { Length: > 0 } && Text(assignee, "accountId") == me,
        };
    }

    /// <summary>Задача по её ключу «PAY-12»: имя — как у кита, «Jira PAY-12», адрес — страница задачи.</summary>
    public static TrackerIssue? Issue(string server, string? id, string title)
    {
        if (id is null || id.LastIndexOf('-') is var dash && dash < 1 || !int.TryParse(id[(dash + 1)..], out var number))
            return null;
        return new TrackerIssue($"Jira {id}", number, title, $"{server.TrimEnd('/')}/browse/{id}");
    }

    private sealed record Project(string? Key, string? Problem = null, string? Detail = null);

    /// <summary>Проект — по ключу из описания трекера; 404 — проекта нет или владельцу ключа он не виден, Jira их не различает.</summary>
    private async Task<Project> ProjectAsync(
        string server, string email, string key, string project, CancellationToken cancellationToken)
    {
        var reply = await SendAsync(
            Get(server, email, key, $"rest/api/3/project/{Uri.EscapeDataString(project)}"), ReadTimeout, cancellationToken);
        if (reply.Status == HttpStatusCode.NotFound)
            return new Project(null, TrackerIssues.ProjectMissing);
        if (reply.Problem is not null)
            return new Project(null, reply.Problem, reply.Detail);
        return Text(reply.Json, "key") is { Length: > 0 } found
            ? new Project(found)
            : new Project(null, TrackerIssues.JiraError, NotJira);
    }

    private const string NotJira = "сервер ответил не как Jira";

    /// <summary>Строковое поле объекта ответа; ответ не того вида — null, а не исключение.</summary>
    private static string? Text(JsonNode? node, string name) =>
        node is JsonObject obj && obj[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private sealed record Reply(JsonNode? Json, string? Problem = null, string? Detail = null, HttpStatusCode? Status = null);

    private static HttpRequestMessage Get(string server, string email, string key, string path)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(server.TrimEnd('/') + "/"), path));
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{email}:{key}")));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return request;
    }

    /// <summary>
    /// Запрос к Jira. Ключ не попадает ни в Detail, ни в ответ панели: отказ называется кодом и строкой
    /// сервера, а не запросом.
    /// </summary>
    private async Task<Reply> SendAsync(HttpRequestMessage request, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var _ = request;
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        try
        {
            using var response = await clients.CreateClient(Client).SendAsync(request, limit.Token);
            var text = await response.Content.ReadAsStringAsync(limit.Token);
            if (response.StatusCode is HttpStatusCode.Unauthorized)
                return new Reply(null, TrackerIssues.KeyRejected);
            // Действующий ключ, у владельца которого нет прав на это действие: менять ключ незачем
            if (response.StatusCode is HttpStatusCode.Forbidden)
                return new Reply(null, TrackerIssues.KeyForbidden, Described(text));
            if (!response.IsSuccessStatusCode)
                return new Reply(null, TrackerIssues.JiraError, Described(text) ?? $"HTTP {(int)response.StatusCode}", response.StatusCode);
            try
            {
                return new Reply(JsonNode.Parse(text));
            }
            catch (JsonException)
            {
                return new Reply(null, TrackerIssues.JiraError, NotJira);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new Reply(null, TrackerIssues.ServerSilent, "истекло время ожидания");
        }
        catch (HttpRequestException e)
        {
            return new Reply(null, TrackerIssues.ServerSilent, e.HttpRequestError switch
            {
                HttpRequestError.NameResolutionError => "адрес сервера не найден",
                HttpRequestError.ConnectionError => "не удалось подключиться",
                HttpRequestError.SecureConnectionError => "не удалось установить защищённое соединение",
                _ => "соединение прервалось",
            });
        }
    }

    /// <summary>Отказ Jira объясняет списком errorMessages или полями errors своего ответа — первая строка.</summary>
    private static string? Described(string text)
    {
        try
        {
            var json = JsonNode.Parse(text);
            var messages = (json?["errorMessages"] as JsonArray)?.Select(m => m is JsonValue v && v.TryGetValue<string>(out var s) ? s : null)
                ?? [];
            var fields = (json?["errors"] as JsonObject)?.Select(f => f.Value is JsonValue v && v.TryGetValue<string>(out var s) ? s : null)
                ?? [];
            return messages.Concat(fields).FirstOrDefault(m => m is { Length: > 0 });
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
