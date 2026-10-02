using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class JiraApiTests
{
    private const string Server = "https://acme.atlassian.net";
    private const string Email = "anna@acme.example";
    private const string Key = "ключ-оператора";

    private readonly List<(HttpMethod Method, string Url, string? Auth, string? Body)> _asked = [];

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private const string Me = """{"accountId":"acc-anna","emailAddress":"anna@acme.example","displayName":"Анна Петрова"}""";
    private const string Pay = """
        {"id":"10001","key":"PAY","issueTypes":[
          {"id":"3","name":"Подзадача","subtask":true},{"id":"5","name":"Bug","subtask":false},{"id":"7","name":"Task","subtask":false}]}
        """;

    private JiraApi Api(Func<HttpRequestMessage, HttpResponseMessage> answer) =>
        new(new Clients(new Handler(request =>
        {
            // Задачи и владелец ключа спрашиваются разом
            lock (_asked)
                _asked.Add((request.Method, request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(),
                    request.Content?.ReadAsStringAsync().Result));
            return answer(request);
        })));

    /// <summary>Ответы по пути запроса: владелец ключа, проект, поиск.</summary>
    private JiraApi Routed(Func<HttpRequestMessage, HttpResponseMessage> search, string project = Pay) =>
        Api(request => request.RequestUri!.AbsolutePath switch
        {
            "/rest/api/3/myself" => Json(Me),
            var path when path.StartsWith("/rest/api/3/project/") => Json(project),
            _ => search(request),
        });

    private string SearchAsked(int page = 0) =>
        Uri.UnescapeDataString(_asked.Where(a => a.Url.Contains("/search/jql?")).ElementAt(page).Url);

    [Fact]
    public async Task Who_NamesAccountAndEmailOfKeyOwner_WithBasicAuth()
    {
        var who = await Api(_ => Json(Me)).WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(new JiraUser("acc-anna", "anna@acme.example"), who);
        var (method, url, auth, _) = Assert.Single(_asked);
        Assert.Equal(HttpMethod.Get, method);
        Assert.Equal("https://acme.atlassian.net/rest/api/3/myself", url);
        Assert.Equal($"Basic {Convert.ToBase64String(Encoding.UTF8.GetBytes($"{Email}:{Key}"))}", auth);
    }

    /// <summary>Почту владельца Jira может прятать настройкой приватности — тогда он назван именем.</summary>
    [Fact]
    public async Task Who_HiddenEmail_NamesDisplayName()
    {
        var who = await Api(_ => Json("""{"accountId":"acc-anna","displayName":"Анна Петрова"}""")).WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(new JiraUser("acc-anna", "Анна Петрова"), who);
    }

    [Fact]
    public async Task Who_RefusedKey_IsKeyRejected()
    {
        var who = await Api(_ => Json("{}", HttpStatusCode.Unauthorized)).WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(new JiraUser(null, null, TrackerIssues.KeyRejected), who);
    }

    [Theory]
    [InlineData("<html>Вход</html>")]
    [InlineData("""{"name":"не Jira"}""")]
    public async Task Who_NotJira_IsJiraError(string answer)
    {
        var who = await Api(_ => Json(answer)).WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(TrackerIssues.JiraError, who.Problem);
        Assert.Null(who.AccountId);
    }

    [Fact]
    public async Task Who_NoConnection_IsServerSilentWithoutKey()
    {
        var who = await Api(_ => throw new HttpRequestException(HttpRequestError.NameResolutionError, $"host {Key}"))
            .WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(TrackerIssues.ServerSilent, who.Problem);
        Assert.Equal("адрес сервера не найден", who.Detail);
    }

    [Fact]
    public async Task Who_OtherRefusal_CarriesJiraMessage()
    {
        var who = await Api(_ => Json("""{"errorMessages":["Сайт на обслуживании"],"errors":{}}""", HttpStatusCode.ServiceUnavailable))
            .WhoAsync(Server, Email, Key, CancellationToken.None);

        Assert.Equal(new JiraUser(null, null, TrackerIssues.JiraError, "Сайт на обслуживании"), who);
    }

    /// <summary>
    /// Незакрытая — без решения и со статусом не из группы «Готово» (ответ оператора на B-285); отбора по исполнителю
    /// нет, сто первая задача спрашивается — понять, есть ли ещё (AKW-17).
    /// </summary>
    [Fact]
    public async Task Open_ReadsAllUnresolvedNotDoneIssuesOfProject()
    {
        var api = Routed(_ => Json("""
            {"issues":[
              {"key":"PAY-12","fields":{"summary":"Оплата падает","assignee":{"accountId":"acc-anna","displayName":"Анна Петрова"}}},
              {"key":"PAY-7","fields":{"summary":"Отчёты","assignee":null}},
              {"key":"PAY-31","fields":{"summary":"Возвраты","assignee":{"accountId":"acc-ivan","displayName":"Иван Смирнов"}}}
            ],"isLast":true}
            """));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.False(issues.Truncated);
        Assert.Equal(
            [
                new TrackerIssue("Jira PAY-12", 12, "Оплата падает", "https://acme.atlassian.net/browse/PAY-12", Assignee: "Анна Петрова", Mine: true),
                new TrackerIssue("Jira PAY-7", 7, "Отчёты", "https://acme.atlassian.net/browse/PAY-7"),
                new TrackerIssue("Jira PAY-31", 31, "Возвраты", "https://acme.atlassian.net/browse/PAY-31", Assignee: "Иван Смирнов"),
            ],
            issues.Issues);
        var query = SearchAsked();
        Assert.Contains("jql=project = \"PAY\" AND resolution = EMPTY AND statusCategory != Done ORDER BY created DESC&", query);
        Assert.Contains("fields=summary,assignee", query);
        Assert.Contains("maxResults=101", query);
        Assert.DoesNotContain("currentUser", query);
    }

    /// <summary>Ключ проекта в описании может быть строчными — в запрос идёт ключ, который назвала Jira.</summary>
    [Fact]
    public async Task Open_UsesProjectKeyAsJiraNamesIt()
    {
        var api = Routed(_ => Json("""{"issues":[],"isLast":true}"""));

        await api.OpenAsync(Server, Email, Key, "pay", null, CancellationToken.None);

        Assert.Contains(_asked, a => a.Url == "https://acme.atlassian.net/rest/api/3/project/pay");
        Assert.Contains("project = \"PAY\"", SearchAsked());
    }

    /// <summary>Фильтр — в скобках: «status = A OR status = B» без них вывел бы поиск за незакрытые задачи проекта.</summary>
    [Fact]
    public async Task Open_FilterGoesInBrackets()
    {
        var api = Routed(_ => Json("""{"issues":[],"isLast":true}"""));

        await api.OpenAsync(Server, Email, Key, "PAY", "  assignee = currentUser() OR labels = ops ", CancellationToken.None);

        Assert.Contains(
            "project = \"PAY\" AND resolution = EMPTY AND statusCategory != Done AND (assignee = currentUser() OR labels = ops) ORDER BY created DESC",
            SearchAsked());
    }

    [Fact]
    public async Task Open_SearchRefusedWithFilter_IsFilterRejected()
    {
        var api = Routed(_ => Json("""{"errorMessages":["Field 'asignee' does not exist."]}""", HttpStatusCode.BadRequest));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", "asignee = x", CancellationToken.None);

        Assert.Equal(new TrackerIssues([], TrackerIssues.FilterRejected, "Field 'asignee' does not exist."), issues);
    }

    /// <summary>Без фильтра отказ поиска фильтр не винит.</summary>
    [Fact]
    public async Task Open_SearchRefusedWithoutFilter_IsJiraError()
    {
        var api = Routed(_ => Json("""{"errorMessages":["Что-то не так"]}""", HttpStatusCode.BadRequest));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.Equal(new TrackerIssues([], TrackerIssues.JiraError, "Что-то не так"), issues);
    }

    /// <summary>Проекта нет — «проект не найден», а не «Jira не приняла фильтр»: поиск тогда не спрашивается.</summary>
    [Fact]
    public async Task Open_MissingProject_IsProjectMissing()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.StartsWith("/rest/api/3/project/")
            ? Json("""{"errorMessages":["No project could be found with key 'PAY'."]}""", HttpStatusCode.NotFound)
            : Json(Me));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", "assignee = currentUser()", CancellationToken.None);

        Assert.Equal(new TrackerIssues([], TrackerIssues.ProjectMissing), issues);
        Assert.DoesNotContain(_asked, a => a.Url.Contains("/search/jql"));
    }

    [Fact]
    public async Task Open_RefusedKey_IsKeyRejected()
    {
        var issues = await Api(_ => Json("{}", HttpStatusCode.Unauthorized)).OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.Equal(new TrackerIssues([], TrackerIssues.KeyRejected), issues);
    }

    /// <summary>Ключ отклонён, а про проект сервер ответил «не найден» — причина всё равно ключ (ревью B-285).</summary>
    [Fact]
    public async Task Open_KeyRejectedButProjectNotFound_IsKeyRejected()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath == "/rest/api/3/myself"
            ? Json("{}", HttpStatusCode.Unauthorized)
            : Json("{}", HttpStatusCode.NotFound));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.Equal(new TrackerIssues([], TrackerIssues.KeyRejected), issues);
    }

    /// <summary>Владелец ключа не узнан — задачи видны, своих не отмечено.</summary>
    [Fact]
    public async Task Open_OwnerUnknown_ShowsIssuesWithoutMine()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath switch
        {
            "/rest/api/3/myself" => Json("{}", HttpStatusCode.InternalServerError),
            var path when path.StartsWith("/rest/api/3/project/") => Json(Pay),
            _ => Json("""{"issues":[{"key":"PAY-12","fields":{"summary":"Т","assignee":{"accountId":"acc-anna","displayName":"Анна"}}}],"isLast":true}"""),
        });

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.False(Assert.Single(issues.Issues).Mine);
    }

    /// <summary>Jira отдаёт страницу меньше запрошенной — поиск листается до предела и одной сверх него.</summary>
    [Fact]
    public async Task Open_MoreThanLimit_PagesUpToOneOverAndTruncates()
    {
        static string Page(int from, int count, string next) => new JsonObject
        {
            ["issues"] = new JsonArray([.. Enumerable.Range(from, count).Select(n => (JsonNode)new JsonObject
            {
                ["key"] = $"PAY-{n}",
                ["fields"] = new JsonObject { ["summary"] = $"З{n}" },
            })]),
            ["nextPageToken"] = next,
            ["isLast"] = false,
        }.ToJsonString();
        var api = Routed(request => request.RequestUri!.Query.Contains("nextPageToken")
            ? Json(Page(51, 51, "ещё"))
            : Json(Page(1, 50, "стр 2")));

        var issues = await api.OpenAsync(Server, Email, Key, "PAY", null, CancellationToken.None);

        Assert.True(issues.Truncated);
        Assert.Equal(TrackerIssues.Limit, issues.Issues.Count);
        Assert.Contains("maxResults=51&nextPageToken=стр 2", SearchAsked(1));
        Assert.Equal(2, _asked.Count(a => a.Url.Contains("/search/jql")));
    }

    [Theory]
    [InlineData("PAY-12", 12)]
    [InlineData("PAY2-7", 7)]
    public void Issue_NamesItAsKit(string id, int number)
    {
        var issue = JiraApi.Issue("https://acme.atlassian.net/", id, "Т");

        Assert.Equal(new TrackerIssue($"Jira {id}", number, "Т", $"https://acme.atlassian.net/browse/{id}"), issue);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("PAY")]
    [InlineData("-12")]
    [InlineData("PAY-x")]
    public void Issue_WithoutNumber_IsNull(string? id)
    {
        Assert.Null(JiraApi.Issue(Server, id, "Т"));
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request));
    }

    private sealed class Clients(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
