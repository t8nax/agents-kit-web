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
            // Задачи и владелец ключа спрашиваются разом
            lock (_asked)
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

    /// <summary>Вопрос о задачах — поиск задач среди всех вопросов чтения: владелец ключа спрашивается рядом.</summary>
    private string IssuesAsked() =>
        Uri.UnescapeDataString(Assert.Single(_asked, a => a.Url.Contains("/api/issues?")).Url);

    /// <summary>
    /// Отбора по исполнителю в запросе нет: «for: me» облачный YouTrack искал текстом и находил одну задачу, где эти
    /// слова процитированы (AKW-17). Видны все незакрытые задачи проекта, сто первая спрашивается — понять, есть ли ещё.
    /// </summary>
    [Fact]
    public async Task Open_ReadsAllUnresolvedIssuesOfProject()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-7","shortName":"ABCD"},{"id":"0-1","shortName":"ABC"}]""")
            : Json("""[{"idReadable":"ABC-12","summary":"Оплата падает"},{"idReadable":"ABC-1287","summary":"Отчёты"}]"""));

        var issues = await api.OpenAsync(Server, Key, "abc", null, CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.Equal(
            [
                new TrackerIssue("YouTrack ABC-12", 12, "Оплата падает", "https://yt.acme.local/youtrack/issue/ABC-12"),
                new TrackerIssue("YouTrack ABC-1287", 1287, "Отчёты", "https://yt.acme.local/youtrack/issue/ABC-1287"),
            ],
            issues.Issues);
        var query = IssuesAsked();
        Assert.Contains("query=project: {ABC} #Unresolved&", query);
        Assert.DoesNotContain("for: me", query);
        Assert.Contains("$top=101", query);
    }

    /// <summary>
    /// Исполнитель — поле Assignee: полное имя, без него логин; своя задача — логин владельца ключа, без регистра.
    /// Владельца не узнали — своих не отмечено, а задачи видны.
    /// </summary>
    [Fact]
    public async Task Open_TakesAssigneeAndMarksKeyOwnerIssues()
    {
        const string answer = """
            [{"idReadable":"ABC-1","summary":"А","customFields":[{"name":"Priority","value":{"name":"Normal"}},
               {"name":"Assignee","value":{"login":"Boris.K","fullName":"Борис Ким"}}]},
             {"idReadable":"ABC-2","summary":"Б","customFields":[{"name":"Assignee","value":{"login":"anna","fullName":""}}]},
             {"idReadable":"ABC-3","summary":"В","customFields":[{"name":"Assignee","value":null}]},
             {"idReadable":"ABC-4","summary":"Г"}]
            """;
        HttpResponseMessage Answer(HttpRequestMessage request, string me) => request.RequestUri!.AbsolutePath switch
        {
            var p when p.EndsWith("/users/me") => Json(me),
            var p when p.EndsWith("/admin/projects") => Json("""[{"id":"0-1","shortName":"ABC"}]"""),
            _ => Json(answer),
        };

        var issues = await Api(r => Answer(r, """{"login":"boris.k"}""")).OpenAsync(Server, Key, "ABC", null, CancellationToken.None);
        Assert.Contains("fields=idReadable,summary,customFields(name,value(login,fullName))&", IssuesAsked());
        var unknown = await Api(r => Answer(r, "{}")).OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

        Assert.Equal(
            [("Борис Ким", true), ("anna", false), (null, false), (null, false)],
            issues.Issues.Select(i => (i.Assignee, i.Mine)));
        Assert.All(unknown.Issues, i => Assert.False(i.Mine));
        Assert.Equal("Борис Ким", unknown.Issues[0].Assignee);
    }

    [Fact]
    public async Task Open_MoreThanHundred_KeepsHundredAndIsTruncated()
    {
        var many = new JsonArray([.. Enumerable.Range(1, 101).Select(i => (JsonNode)new JsonObject { ["idReadable"] = $"ABC-{i}", ["summary"] = "Т" })]);
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-1","shortName":"ABC"}]""")
            : Json(many.ToJsonString()));

        var issues = await api.OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

        Assert.True(issues.Truncated);
        Assert.Equal(100, issues.Issues.Count);
    }

    /// <summary>
    /// Фильтр описания дописывается к запросу панели в скобках (B-300): «or» в нём не выводит поиск за незакрытые
    /// задачи проекта (ревью B-300). «Только свои» — фильтром Assignee: me.
    /// </summary>
    [Fact]
    public async Task Open_WithFilter_AppendsItToSearch()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-1","shortName":"ABC"}]""")
            : Json("""[{"idReadable":"ABC-12","summary":"Оплата падает"}]"""));

        var issues = await api.OpenAsync(Server, Key, "ABC", " Assignee: me ", CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.Contains("query=project: {ABC} #Unresolved and (Assignee: me)&", IssuesAsked());
    }

    /// <summary>YouTrack отверг поиск с отбором — не принята строка отбора, а не сервер сломан.</summary>
    [Fact]
    public async Task Open_FilterRefused_IsFilterRejectedWithYouTrackWords()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-1","shortName":"ABC"}]""")
            : Json("""{"error":"bad_request","error_description":"Unknown field \"Stat\""}""", HttpStatusCode.BadRequest));

        var filtered = await api.OpenAsync(Server, Key, "ABC", "Stat: {To Do}", CancellationToken.None);
        var plain = await api.OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

        Assert.Equal((TrackerIssues.FilterRejected, "Unknown field \"Stat\""), (filtered.Problem, filtered.Detail));
        Assert.Equal(TrackerIssues.YouTrackError, plain.Problem);
    }

    /// <summary>Сбой сервера при поиске с фильтром — ошибка YouTrack, а не отказ фильтра (ревью B-300).</summary>
    [Fact]
    public async Task Open_ServerFailureWithFilter_IsYouTrackError()
    {
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? Json("""[{"id":"0-1","shortName":"ABC"}]""")
            : Json("<html>Bad Gateway</html>", HttpStatusCode.BadGateway));

        var issues = await api.OpenAsync(Server, Key, "ABC", "State: {To Do}", CancellationToken.None);

        Assert.Equal((TrackerIssues.YouTrackError, "HTTP 502"), (issues.Problem, issues.Detail));
    }

    /// <summary>Проектов с искомым в имени больше страницы — нужный ищется и на следующих (ревью B-288).</summary>
    [Fact]
    public async Task Open_ProjectOnSecondPage_IsFound()
    {
        var firstPage = new JsonArray([.. Enumerable.Range(0, 100).Select(i => (JsonNode)new JsonObject { ["id"] = $"0-{i}", ["shortName"] = $"ABC{i}" })]);
        var api = Api(request => request.RequestUri!.AbsolutePath.EndsWith("/admin/projects")
            ? request.RequestUri.Query.Contains("$skip=0") ? Json(firstPage.ToJsonString()) : Json("""[{"id":"0-500","shortName":"ABC"}]""")
            : Json("""[{"idReadable":"ABC-1","summary":"Т"}]"""));

        var issues = await api.OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

        Assert.Null(issues.Problem);
        Assert.Equal("YouTrack ABC-1", Assert.Single(issues.Issues).Name);
        Assert.Contains("$skip=100", _asked.Where(a => a.Url.Contains("/admin/projects")).ElementAt(1).Url);
    }

    [Fact]
    public async Task Open_ProjectNotVisible_IsProjectMissingWithoutReadingIssues()
    {
        var issues = await Api(_ => Json("""[{"id":"0-7","shortName":"ABCD"}]"""))
            .OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

        Assert.Equal(TrackerIssues.ProjectMissing, issues.Problem);
        Assert.DoesNotContain(_asked, a => a.Url.Contains("/api/issues?"));
    }

    [Fact]
    public async Task Open_KeyRejected_IsKeyRejected()
    {
        var issues = await Api(_ => Json("{}", HttpStatusCode.Unauthorized)).OpenAsync(Server, Key, "ABC", null, CancellationToken.None);

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
