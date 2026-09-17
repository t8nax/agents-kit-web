using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class OperatorEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-operator-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _memoryPath;
    private readonly string _sessionsDir;
    private readonly FakeEditorWindows _windows = new();
    private readonly WebApplicationFactory<Program> _factory;

    private const string Sections = """
        ## Критерии закрытия

        ### 1. Окно есть
        Оператор отвечает из панели.

        ### Не входит
        Health баз.

        ### Дизайн
        Макет окна: https://claude.ai/artifact/AbC123

        ## Оператору

        ### Подтвердить критерий?
        За вами объём проверок.

        ответ:

        ### Как быть с переносами?
        Ответ одной строкой.

        - вариант: заменять пробелами — абзацы теряются
        - вариант: не отправлять — оператор переписывает
        - рекомендовано: заменять пробелами — абзацы теряются

        ответ:

        ### Старый вопрос?
        Уже решён.

        ответ: да
        """;

    public OperatorEndpointsTests()
    {
        _copy = Path.Combine(_root, "app");
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{\"workspaces\":[]}");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        _memoryPath = Path.Combine(_base, "work", "app.md");
        File.WriteAllText(_memoryPath, $"# Окно ответа\nрабочая копия: {_copy}\nветка: feat/x\n\n{Sections}\n\n## Агенту\n\n### Флоу\n- [ ] 1. Критерий\n");

        var outsider = Path.Combine(_root, "other-knowledge");
        Directory.CreateDirectory(Path.Combine(outsider, "work"));
        File.WriteAllText(Path.Combine(outsider, "work", "app.md"), File.ReadAllText(_memoryPath));

        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, _base)),
                    new("SessionsDir", _sessionsDir),
                ]);
            });
            // Окно редактора в прогоне не поднимается: запуск подменяется, проверяется переданный путь.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IEditorWindows>();
                services.AddSingleton<IEditorWindows>(_windows);
            });
        });
    }

    [Fact]
    public async Task Questions_ReturnsUnansweredQuestionsWithTaskAndCriteria()
    {
        var response = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.NotNull(response);
        Assert.Equal("App", response.Project);
        Assert.Equal("Окно ответа", response.Task);
        Assert.Equal([new ClosingCriterion("1. Окно есть", "Оператор отвечает из панели.")], response.Criteria);
        Assert.Equal("Health баз.", response.OutOfScope);
        Assert.Equal("Макет окна: https://claude.ai/artifact/AbC123", response.Design);
        Assert.Equal(["Подтвердить критерий?", "Как быть с переносами?"], response.Questions.Select(q => q.Title));
        Assert.Equal("За вами объём проверок.", response.Questions[0].Context);
        Assert.True(response.Questions[1].Variants[0].Recommended);
        Assert.False(response.Questions[1].Variants[1].Recommended);
    }

    [Fact]
    public async Task Answers_WritesAllAnswersAndCopyStopsWaiting()
    {
        var response = await PostAnswers(_base, _copy, ("Подтвердить критерий?", "принимаю"), ("Как быть с переносами?", "заменять\nпробелами"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var memory = WorkMemory.Parse(await File.ReadAllTextAsync(_memoryPath));
        Assert.False(memory.WaitingForOperator);
        Assert.Equal(["принимаю", "заменять пробелами", "да"], memory.Questions.Select(q => q.Answer));
    }

    [Fact]
    public async Task Answers_EmptyAnswer_IsBadRequestAndWritesNothing()
    {
        var before = await File.ReadAllTextAsync(_memoryPath);

        var response = await PostAnswers(_base, _copy, ("Подтвердить критерий?", "принимаю"), ("Как быть с переносами?", " "));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AnswersRejectedResponse("Как быть с переносами?", "empty"), await response.Content.ReadFromJsonAsync<AnswersRejectedResponse>());
        Assert.Equal(before, await File.ReadAllTextAsync(_memoryPath));
    }

    [Fact]
    public async Task Answers_AlreadyAnsweredQuestion_IsConflictAndWritesNothing()
    {
        var before = await File.ReadAllTextAsync(_memoryPath);

        var response = await PostAnswers(_base, _copy, ("Подтвердить критерий?", "принимаю"), ("Старый вопрос?", "нет"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(new AnswersRejectedResponse("Старый вопрос?", "already-answered"), await response.Content.ReadFromJsonAsync<AnswersRejectedResponse>());
        Assert.Equal(before, await File.ReadAllTextAsync(_memoryPath));
    }

    [Fact]
    public async Task Answers_BaseNotInConfiguration_IsNotFoundAndWritesNothing()
    {
        var outsiderMemory = Path.Combine(_root, "other-knowledge", "work", "app.md");
        var before = await File.ReadAllTextAsync(outsiderMemory);

        var response = await PostAnswers(Path.Combine(_root, "other-knowledge"), _copy, ("Подтвердить критерий?", "да"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(before, await File.ReadAllTextAsync(outsiderMemory));
    }

    [Fact]
    public async Task Answers_PathTraversalInBase_IsNotFound()
    {
        var response = await PostAnswers(Path.Combine(_base, "..", "other-knowledge"), _copy, ("Подтвердить критерий?", "да"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Questions_UnknownCopy_IsNotFound()
    {
        var response = await _factory.CreateClient().GetAsync(QuestionsUrl(_base, Path.Combine(_root, "nope")));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Questions_LiveVsCodeSessionInCopy_IsReported()
    {
        WriteSession(_copy);

        var response = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.True(response!.VsCodeSession);
    }

    [Fact]
    public async Task Questions_SessionInTerminalOrOtherCopy_IsNotReported()
    {
        WriteSession(_copy, entrypoint: "cli");
        WriteSession(Path.Combine(_root, "other-copy"));

        var response = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.False(response!.VsCodeSession);
    }

    [Fact]
    public async Task OpenSession_LiveVsCodeSession_RaisesWindowOfThatCopy()
    {
        WriteSession(_copy);

        var response = await PostOpenSession(_base, _copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([_copy], _windows.Raised);
    }

    [Fact]
    public async Task OpenSession_NoVsCodeSession_IsConflictAndRaisesNothing()
    {
        var response = await PostOpenSession(_base, _copy);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(new OpenSessionFailedResponse("no-session"), await response.Content.ReadFromJsonAsync<OpenSessionFailedResponse>());
        Assert.Empty(_windows.Raised);
    }

    [Fact]
    public async Task OpenSession_WindowNotRaised_IsBadGateway()
    {
        WriteSession(_copy);
        _windows.Result = false;

        var response = await PostOpenSession(_base, _copy);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal(new OpenSessionFailedResponse("not-raised"), await response.Content.ReadFromJsonAsync<OpenSessionFailedResponse>());
    }

    [Fact]
    public async Task OpenSession_BaseNotInConfiguration_IsNotFoundAndRaisesNothing()
    {
        WriteSession(_copy);

        var response = await PostOpenSession(Path.Combine(_root, "other-knowledge"), _copy);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.Raised);
    }

    [Fact]
    public async Task OpenWorkspace_LiveVsCodeSession_RaisesItsWindowInsteadOfOpeningOne()
    {
        WriteSession(_copy);

        var response = await PostOpenWorkspace(_base, _copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([_copy], _windows.Raised);
        Assert.Empty(_windows.Opened);
    }

    [Fact]
    public async Task OpenWorkspace_CopyWithoutVsCodeSession_OpensWindowOnIt()
    {
        var response = await PostOpenWorkspace(_base, _copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([_copy], _windows.Opened);
        Assert.Empty(_windows.Raised);
    }

    [Fact]
    public async Task OpenWorkspace_FreeCopy_OpensWindowOnIt()
    {
        var free = FreeCopy();

        var response = await PostOpenWorkspace(_base, free);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([free], _windows.Opened);
    }

    // Сессия в терминале своего окна не имеет: поднимать нечего, копия открывается как любая другая.
    [Fact]
    public async Task OpenWorkspace_SessionInTerminal_OpensWindowOnIt()
    {
        WriteSession(_copy, entrypoint: "cli");

        var response = await PostOpenWorkspace(_base, _copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([_copy], _windows.Opened);
        Assert.Empty(_windows.Raised);
    }

    [Fact]
    public async Task OpenWorkspace_WindowNotOpened_IsBadGateway()
    {
        _windows.Result = false;

        var response = await PostOpenWorkspace(_base, _copy);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal(new OpenWorkspaceFailedResponse("not-opened"), await response.Content.ReadFromJsonAsync<OpenWorkspaceFailedResponse>());
    }

    [Fact]
    public async Task OpenWorkspace_CopyOutsideBase_IsNotFoundAndOpensNothing()
    {
        var response = await PostOpenWorkspace(_base, Path.Combine(_root, "nope"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.Opened);
        Assert.Empty(_windows.Raised);
    }

    [Fact]
    public async Task OpenWorkspace_BaseNotInConfiguration_IsNotFoundAndOpensNothing()
    {
        var response = await PostOpenWorkspace(Path.Combine(_root, "other-knowledge"), _copy);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.Opened);
        Assert.Empty(_windows.Raised);
    }

    /// <summary>Копия без памяти: такой строкой таблицы её делает только git, поэтому нужен репозиторий.</summary>
    private string FreeCopy()
    {
        var free = TestGit.Repository(Path.Combine(_root, "free"));
        File.WriteAllText(
            Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = new[] { free } }));
        return free;
    }

    private static string QuestionsUrl(string basePath, string copy) =>
        $"/api/questions?base={Uri.EscapeDataString(basePath)}&copy={Uri.EscapeDataString(copy)}";

    private Task<HttpResponseMessage> PostOpenSession(string basePath, string copy) =>
        _factory.CreateClient().PostAsJsonAsync("/api/session/open", new OpenSessionRequest(basePath, copy));

    private Task<HttpResponseMessage> PostOpenWorkspace(string basePath, string copy) =>
        _factory.CreateClient().PostAsJsonAsync("/api/workspace/open", new OpenWorkspaceRequest(basePath, copy));

    // Живой сессией считается та, чей процесс существует, поэтому в фикстуре стоит pid самого прогона.
    private void WriteSession(string cwd, string entrypoint = "claude-vscode") =>
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{Guid.NewGuid():N}.json"),
            $$"""{"pid":{{Environment.ProcessId}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"{{entrypoint}}"}""");

    private sealed class FakeEditorWindows : IEditorWindows
    {
        public List<string> Raised { get; } = [];

        public List<string> Opened { get; } = [];

        public bool Result { get; set; } = true;

        public Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken)
        {
            Raised.Add(copyPath);
            return Task.FromResult(Result);
        }

        public Task<bool> OpenAsync(string copyPath, CancellationToken cancellationToken)
        {
            Opened.Add(copyPath);
            return Task.FromResult(Result);
        }

        public Task<bool> OpenFileAsync(string folder, string file, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }

    private Task<HttpResponseMessage> PostAnswers(string basePath, string copy, params (string Question, string Answer)[] answers) =>
        _factory.CreateClient().PostAsJsonAsync("/api/answers",
            new AnswersRequest(basePath, copy, answers.Select(a => new OperatorAnswer(a.Question, a.Answer)).ToList()));

    public void Dispose()
    {
        _factory.Dispose();
        try
        {
            // Объекты git лежат только для чтения: без снятия атрибута каталог прогона не удалить.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
