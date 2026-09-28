using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class YouTrackApiTests
{
    private const string Server = "https://yt.acme.local/youtrack";
    private const string Key = "perm:ключ-оператора";

    private readonly List<(HttpMethod Method, string Url, string? Auth, string? Body)> _asked = [];

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private YouTrackApi Api(Func<HttpRequestMessage, HttpResponseMessage> answer) =>
        new(new Clients(new Handler(request =>
        {
            _asked.Add((request.Method, request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(),
                request.Content?.ReadAsStringAsync().Result));
            return answer(request);
        })));

    [Fact]
    public async Task Who_NamesLoginOfKeyOwner()
    {
        var who = await Api(_ => Json("""{"login":"boris.k","$type":"Me"}""")).WhoAsync(Server, Key, CancellationToken.None);

        Assert.Equal(new YouTrackUser("boris.k"), who);
        var (method, url, auth, _) = Assert.Single(_asked);
        Assert.Equal(HttpMethod.Get, method);
        Assert.Equal("https://yt.acme.local/youtrack/api/users/me?fields=login", url);
        Assert.Equal($"Bearer {Key}", auth);
    }

    [Fact]
    public async Task Who_RefusedKey_IsKeyRejected()
    {
        var who = await Api(_ => Json("""{"error":"Unauthorized"}""", HttpStatusCode.Unauthorized)).WhoAsync(Server, Key, CancellationToken.None);

        Assert.Equal(new YouTrackUser(null, TrackerIssues.KeyRejected), who);
    }

    /// <summary>403 — ключ действует, но у владельца нет прав: «замените ключ» тут советовать незачем (ревью B-288).</summary>
    [Fact]
    public async Task Create_Forbidden_IsKeyForbiddenNotRejected()
    {
        var api = Api(request => request.Method == HttpMethod.Post
            ? Json("""{"error":"Forbidden","error_description":"Нет прав на создание задач"}""", HttpStatusCode.Forbidden)
            : request.RequestUri!.AbsolutePath.EndsWith("/users/me") ? Json("""{"login":"b"}""") : Json("""[{"id":"0-1","shortName":"ABC"}]"""));

        var created = await api.CreateAsync(Server, Key, "ABC", "Т", "О");

        Assert.Equal(new CreatedIssue(null, TrackerIssues.KeyForbidden, "Нет прав на создание задач"), created);
        Assert.False(created.MaybeCreated);
    }

    [Fact]
    public async Task Who_NoConnection_IsServerSilentWithoutKey()
    {
        var who = await Api(_ => throw new HttpRequestException(HttpRequestError.NameResolutionError, $"host {Key}"))
            .WhoAsync(Server, Key, CancellationToken.None);

        Assert.Equal(TrackerIssues.ServerSilent, who.Problem);
        Assert.Equal("адрес сервера не найден", who.Detail);
    }

    /// <summary>Страница входа или чужой сайт отвечают не JSON YouTrack — ключ тогда не сохраняется.</summary>
    [Theory]
    [InlineData("<html>Вход</html>")]
    [InlineData("""{"name":"не YouTrack"}""")]
    public async Task Who_NotYouTrack_IsYouTrackError(string answer)
    {
        var who = await Api(_ => Json(answer)).WhoAsync(Server, Key, CancellationToken.None);

        Assert.Equal(TrackerIssues.YouTrackError, who.Problem);
        Assert.Null(who.Login);
    }

    [Fact]
    public async Task Who_OtherRefusal_CarriesYouTrackDescription()
    {
        var who = await Api(_ => Json("""{"error":"x","error_description":"Сервер на обслуживании"}""", HttpStatusCode.ServiceUnavailable))
            .WhoAsync(Server, Key, CancellationToken.None);

        Assert.Equal(new YouTrackUser(null, TrackerIssues.YouTrackError, "Сервер на обслуживании"), who);
    }

    [Fact]
    public async Task Assigned_ReadsUnresolvedIssuesOfProjectForKeyOwner()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-7","shortName":"ABCD"},{"id":"0-1","shortName":"ABC"}]""")
            : Json("""[{"idReadable":"ABC-12","summary":"Оплата падает"},{"idReadable":"ABC-1287","summary":"Отчёты"}]"""));

        var issues = await api.AssignedAsync(Server, Key, "abc", CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.Equal(
            [
                new TrackerIssue("YouTrack ABC-12", 12, "Оплата падает", "https://yt.acme.local/youtrack/issue/ABC-12"),
                new TrackerIssue("YouTrack ABC-1287", 1287, "Отчёты", "https://yt.acme.local/youtrack/issue/ABC-1287"),
            ],
            issues.Issues);
        var query = Uri.UnescapeDataString(_asked[1].Url);
        Assert.Contains("query=project: {ABC} for: me #Unresolved", query);
    }

    /// <summary>Проектов с искомым в имени больше страницы — нужный ищется и на следующих (ревью B-288).</summary>
    [Fact]
    public async Task Assigned_ProjectOnSecondPage_IsFound()
    {
        var firstPage = new JsonArray([.. Enumerable.Range(0, 100).Select(i => (JsonNode)new JsonObject { ["id"] = $"0-{i}", ["shortName"] = $"ABC{i}" })]);
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? request.RequestUri.Query.Contains("$skip=0") ? Json(firstPage.ToJsonString()) : Json("""[{"id":"0-500","shortName":"ABC"}]""")
            : Json("""[{"idReadable":"ABC-1","summary":"Т"}]"""));

        var issues = await api.AssignedAsync(Server, Key, "ABC", CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.Equal("YouTrack ABC-1", Assert.Single(issues.Issues).Name);
        Assert.Contains("$skip=100", _asked[1].Url);
    }

    [Fact]
    public async Task Assigned_ProjectNotVisible_IsProjectMissingWithoutReadingIssues()
    {
        var issues = await Api(_ => Json("""[{"id":"0-7","shortName":"ABCD"}]"""))
            .AssignedAsync(Server, Key, "ABC", CancellationToken.None);

        Assert.Equal(TrackerIssues.ProjectMissing, issues.Problem);
        Assert.Single(_asked);
    }

    [Fact]
    public async Task Assigned_KeyRejected_IsKeyRejected()
    {
        var issues = await Api(_ => Json("{}", HttpStatusCode.Unauthorized)).AssignedAsync(Server, Key, "ABC", CancellationToken.None);

        Assert.Equal(TrackerIssues.KeyRejected, issues.Problem);
        Assert.Empty(issues.Issues);
    }

    [Fact]
    public async Task Create_AssignsIssueToKeyOwnerInProject()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath switch
        {
            var p when p.EndsWith("/users/me") => Json("""{"login":"boris.k"}"""),
            var p when p.EndsWith("/admin/projects") => Json("""[{"id":"0-1","shortName":"ABC"}]"""),
            _ => Json("""{"idReadable":"ABC-58","summary":"Экспорт"}"""),
        });

        var created = await api.CreateAsync(Server, Key, "ABC", "Экспорт истории", "Текст записи.\n\n### Агенту\n- где: App.tsx");

        Assert.Equal(new TrackerIssue("YouTrack ABC-58", 58, "Экспорт истории", "https://yt.acme.local/youtrack/issue/ABC-58"), created.Issue);
        var post = Assert.Single(_asked, a => a.Method == HttpMethod.Post);
        Assert.StartsWith("https://yt.acme.local/youtrack/api/issues?", post.Url);
        var body = JsonNode.Parse(post.Body!)!;
        Assert.Equal("0-1", body["project"]!["id"]!.GetValue<string>());
        Assert.Equal("Экспорт истории", body["summary"]!.GetValue<string>());
        Assert.Equal("Текст записи.\n\n### Агенту\n- где: App.tsx", body["description"]!.GetValue<string>());
        var assignee = Assert.Single(body["customFields"]!.AsArray())!;
        Assert.Equal("Assignee", assignee["name"]!.GetValue<string>());
        Assert.Equal("boris.k", assignee["value"]!["login"]!.GetValue<string>());
    }

    [Fact]
    public async Task Create_ProjectMissing_DoesNotPost()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/users/me") ? Json("""{"login":"b"}""") : Json("[]"));

        var created = await api.CreateAsync(Server, Key, "ABC", "Т", "О");

        Assert.Equal(new CreatedIssue(null, TrackerIssues.ProjectMissing), created);
        Assert.DoesNotContain(_asked, a => a.Method == HttpMethod.Post);
        Assert.False(created.MaybeCreated);
    }

    /// <summary>Оборванное заведение могло завести задачу: оператору говорится «возможно, заведена».</summary>
    [Fact]
    public async Task Create_ConnectionLostOnPost_MayHaveCreated()
    {
        var api = Api(request => request.Method == HttpMethod.Post
            ? throw new HttpRequestException(HttpRequestError.ResponseEnded, "обрыв")
            : request.RequestUri!.AbsolutePath.EndsWith("/users/me") ? Json("""{"login":"b"}""") : Json("""[{"id":"0-1","shortName":"ABC"}]"""));

        var created = await api.CreateAsync(Server, Key, "ABC", "Т", "О");

        Assert.Equal(CreatedIssue.YouTrackSilent, created.Problem);
        Assert.True(created.MaybeCreated);
    }

    [Fact]
    public async Task Create_Refused_IsNotCreated()
    {
        var api = Api(request => request.Method == HttpMethod.Post
            ? Json("""{"error":"bad","error_description":"Поле Assignee не найдено"}""", HttpStatusCode.BadRequest)
            : request.RequestUri!.AbsolutePath.EndsWith("/users/me") ? Json("""{"login":"b"}""") : Json("""[{"id":"0-1","shortName":"ABC"}]"""));

        var created = await api.CreateAsync(Server, Key, "ABC", "Т", "О");

        Assert.Equal(new CreatedIssue(null, TrackerIssues.YouTrackError, "Поле Assignee не найдено"), created);
        Assert.False(created.MaybeCreated);
    }

    [Theory]
    [InlineData("ABC-12", 12)]
    [InlineData("PAY_2-7", 7)]
    public void Issue_NamesItAsKit(string id, int number)
    {
        var issue = YouTrackApi.Issue("https://acme.youtrack.cloud/", id, "Т");

        Assert.Equal(new TrackerIssue($"YouTrack {id}", number, "Т", $"https://acme.youtrack.cloud/issue/{id}"), issue);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("ABC")]
    [InlineData("-12")]
    [InlineData("ABC-x")]
    public void Issue_WithoutNumber_IsNull(string? id)
    {
        Assert.Null(YouTrackApi.Issue("https://acme.youtrack.cloud", id, "Т"));
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
