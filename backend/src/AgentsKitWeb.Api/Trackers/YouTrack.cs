using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>Владелец ключа YouTrack. Problem задан — сервер его не назвал, значения те же, что у TrackerIssues.</summary>
public sealed record YouTrackUser(string? Login, string? Problem = null, string? Detail = null);

public interface IYouTrack
{
    /// <summary>Кому принадлежит ключ: им проверяется ключ при сохранении в разделе «Трекеры».</summary>
    Task<YouTrackUser> WhoAsync(string server, string key, CancellationToken cancellationToken);

    /// <summary>
    /// Незакрытые задачи проекта, назначенные на владельца ключа; filter — строка поиска YouTrack из описания трекера,
    /// дописанная к запросу (B-300), null — без отбора.
    /// </summary>
    Task<TrackerIssues> AssignedAsync(string server, string key, string project, string? filter, CancellationToken cancellationToken);

    /// <summary>Новая задача проекта, назначенная на владельца ключа, без других полей.</summary>
    Task<CreatedIssue> CreateAsync(string server, string key, string project, string title, string body);
}

/// <summary>
/// YouTrack панель читает сама, по REST с постоянным токеном оператора из раздела «Трекеры»: программы, в которую
/// оператор вошёл бы, как в gh, у YouTrack нет — решение оператора на B-288. Проект описание трекера называет
/// коротким именем (ID проекта), а заводит задачу REST по внутреннему id — его панель ищет среди проектов,
/// видимых владельцу ключа; не нашла — проекта нет или к нему нет доступа.
/// </summary>
public sealed class YouTrackApi(IHttpClientFactory clients) : IYouTrack
{
    public const string Client = "youtrack";

    private const int Limit = 100;

    // Чтение ждёт недолго: раздел не должен висеть на открытии. Заведение — дольше: оборванное,
    // оно могло завести задачу, и оператору пришлось бы её искать.
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan CreateTimeout = TimeSpan.FromMinutes(1);

    public async Task<YouTrackUser> WhoAsync(string server, string key, CancellationToken cancellationToken)
    {
        var reply = await SendAsync(Get(server, key, "api/users/me?fields=login"), ReadTimeout, cancellationToken);
        if (reply.Problem is not null)
            return new YouTrackUser(null, reply.Problem, reply.Detail);
        return Text(reply.Json, "login") is { Length: > 0 } login
            ? new YouTrackUser(login)
            : new YouTrackUser(null, TrackerIssues.YouTrackError, NotYouTrack);
    }

    public async Task<TrackerIssues> AssignedAsync(
        string server, string key, string project, string? filter, CancellationToken cancellationToken)
    {
        var found = await ProjectAsync(server, key, project, cancellationToken);
        if (found.Problem is not null)
            return new TrackerIssues([], found.Problem, found.Detail);

        var search = $"project: {{{found.ShortName}}} for: me #Unresolved";
        // Фильтр — в скобках: «and» в поиске YouTrack связывает сильнее «or», и «State: A or State: B» без скобок
        // вернул бы чужие задачи других проектов (ревью B-300).
        if (!string.IsNullOrWhiteSpace(filter))
            search += $" and ({filter.Trim()})";
        var reply = await SendAsync(
            Get(server, key, $"api/issues?query={Uri.EscapeDataString(search)}&fields=idReadable,summary&$top={Limit}"),
            ReadTimeout, cancellationToken);
        // Проект найден и ключ принят — поиск с фильтром, отвергнутый как неверный запрос (400), значит, что YouTrack
        // не принял строку фильтра; сбой сервера (5xx) фильтр не винит.
        if (reply.Status == HttpStatusCode.BadRequest && !string.IsNullOrWhiteSpace(filter))
            return new TrackerIssues([], TrackerIssues.FilterRejected, reply.Detail);
        if (reply.Problem is not null)
            return new TrackerIssues([], reply.Problem, reply.Detail);
        if (reply.Json is not JsonArray issues)
            return new TrackerIssues([], TrackerIssues.YouTrackError, NotYouTrack);
        return new TrackerIssues([.. issues.OfType<JsonObject>()
            .Select(i => Issue(server, Text(i, "idReadable"), Text(i, "summary") ?? ""))
            .OfType<TrackerIssue>()]);
    }

    /// <summary>
    /// Отмены у заведения нет, как у gh (B-286): оборванный запрос мог завести задачу. Задача назначается на
    /// владельца ключа полем «Assignee» того же запроса — задача без исполнителя не заводится вовсе.
    /// </summary>
    public async Task<CreatedIssue> CreateAsync(string server, string key, string project, string title, string body)
    {
        var who = await WhoAsync(server, key, CancellationToken.None);
        if (who.Problem is not null)
            return new CreatedIssue(null, who.Problem, who.Detail);
        var found = await ProjectAsync(server, key, project, CancellationToken.None);
        if (found.Problem is not null)
            return new CreatedIssue(null, found.Problem, found.Detail);

        var payload = new JsonObject
        {
            ["project"] = new JsonObject { ["id"] = found.Id },
            ["summary"] = title,
            ["description"] = body,
            ["customFields"] = new JsonArray(new JsonObject
            {
                ["name"] = "Assignee",
                ["$type"] = "SingleUserIssueCustomField",
                ["value"] = new JsonObject { ["login"] = who.Login },
            }),
        };
        var request = Request(HttpMethod.Post, server, key, "api/issues?fields=idReadable,summary");
        request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
        var reply = await SendAsync(request, CreateTimeout, CancellationToken.None);
        if (reply.Problem == TrackerIssues.ServerSilent)
            return new CreatedIssue(null, CreatedIssue.YouTrackSilent, reply.Detail);
        if (reply.Problem is not null)
            return new CreatedIssue(null, reply.Problem, reply.Detail);
        return Issue(server, Text(reply.Json, "idReadable"), title) is { } issue
            ? new CreatedIssue(issue)
            : new CreatedIssue(null, CreatedIssue.CreatedUnknown);
    }

    /// <summary>Задача по её номеру «ABC-12»: имя — как у кита, «YouTrack ABC-12», адрес — страница задачи.</summary>
    public static TrackerIssue? Issue(string server, string? id, string title)
    {
        if (id is null || id.LastIndexOf('-') is var dash && dash < 1 || !int.TryParse(id[(dash + 1)..], out var number))
            return null;
        return new TrackerIssue($"YouTrack {id}", number, title, $"{server.TrimEnd('/')}/issue/{id}");
    }

    private sealed record Project(string? Id, string? ShortName, string? Problem = null, string? Detail = null);

    /// <summary>
    /// Проект — по точному ID среди проектов, чьё имя или ID содержит искомое: на большом сервере таких бывает
    /// больше страницы, и ответ листается дальше, а не решает по первой сотне (ревью B-288).
    /// </summary>
    private async Task<Project> ProjectAsync(string server, string key, string project, CancellationToken cancellationToken)
    {
        const int pages = 50;
        for (var page = 0; page < pages; page++)
        {
            var reply = await SendAsync(
                Get(server, key,
                    $"api/admin/projects?fields=id,shortName&query={Uri.EscapeDataString(project)}&$skip={page * Limit}&$top={Limit}"),
                ReadTimeout, cancellationToken);
            if (reply.Problem is not null)
                return new Project(null, null, reply.Problem, reply.Detail);
            if (reply.Json is not JsonArray projects)
                return new Project(null, null, TrackerIssues.YouTrackError, NotYouTrack);
            var match = projects.OfType<JsonObject>().FirstOrDefault(p =>
                string.Equals(Text(p, "shortName"), project, StringComparison.OrdinalIgnoreCase));
            if (match is not null && Text(match, "id") is { } id)
                return new Project(id, Text(match, "shortName"));
            if (projects.Count < Limit)
                break;
        }
        return new Project(null, null, TrackerIssues.ProjectMissing);
    }

    private const string NotYouTrack = "сервер ответил не как YouTrack";

    /// <summary>Строковое поле объекта ответа; ответ не того вида — null, а не исключение.</summary>
    private static string? Text(JsonNode? node, string name) =>
        node is JsonObject obj && obj[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private sealed record Reply(JsonNode? Json, string? Problem = null, string? Detail = null, HttpStatusCode? Status = null);

    private static HttpRequestMessage Get(string server, string key, string path) => Request(HttpMethod.Get, server, key, path);

    private static HttpRequestMessage Request(HttpMethod method, string server, string key, string path)
    {
        var request = new HttpRequestMessage(method, new Uri(new Uri(server.TrimEnd('/') + "/"), path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return request;
    }

    /// <summary>
    /// Запрос к YouTrack. Ключ не попадает ни в Detail, ни в ответ панели: отказ называется кодом и строкой
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
            // Действующий ключ, у владельца которого нет прав на это действие: менять ключ незачем (ревью B-288)
            if (response.StatusCode is HttpStatusCode.Forbidden)
                return new Reply(null, TrackerIssues.KeyForbidden, Described(text));
            if (!response.IsSuccessStatusCode)
                return new Reply(null, TrackerIssues.YouTrackError, Described(text) ?? $"HTTP {(int)response.StatusCode}", response.StatusCode);
            try
            {
                return new Reply(JsonNode.Parse(text));
            }
            catch (JsonException)
            {
                return new Reply(null, TrackerIssues.YouTrackError, NotYouTrack);
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

    /// <summary>Отказ YouTrack объясняет полем error_description своего ответа.</summary>
    private static string? Described(string text)
    {
        try
        {
            return Text(JsonNode.Parse(text), "error_description") is { Length: > 0 } description ? description : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
