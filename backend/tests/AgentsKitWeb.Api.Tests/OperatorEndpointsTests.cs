using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class OperatorEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-operator-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly string _memoryPath;
    private readonly WebApplicationFactory<Program> _factory;

    private const string Sections = """
        ## Критерии закрытия

        ### 1. Окно есть
        Оператор отвечает из панели.

        ### Не входит
        Health баз.

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
        _memoryPath = Path.Combine(_base, "work", "app.md");
        File.WriteAllText(_memoryPath, $"# Окно ответа\nрабочая копия: {_copy}\nветка: feat/x\n\n{Sections}\n\n## Агенту\n\n### Флоу\n- [ ] 1. Критерий\n");

        var outsider = Path.Combine(_root, "other-knowledge");
        Directory.CreateDirectory(Path.Combine(outsider, "work"));
        File.WriteAllText(Path.Combine(outsider, "work", "app.md"), File.ReadAllText(_memoryPath));

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, _base))]);
            }));
    }

    [Fact]
    public async Task Questions_ReturnsUnansweredQuestionsWithTaskAndCriteria()
    {
        var response = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.NotNull(response);
        Assert.Equal("app-knowledge", response.Project);
        Assert.Equal("Окно ответа", response.Task);
        Assert.Equal([new ClosingCriterion("1. Окно есть", "Оператор отвечает из панели.")], response.Criteria);
        Assert.Equal("Health баз.", response.OutOfScope);
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

    private static string QuestionsUrl(string basePath, string copy) =>
        $"/api/questions?base={Uri.EscapeDataString(basePath)}&copy={Uri.EscapeDataString(copy)}";

    private Task<HttpResponseMessage> PostAnswers(string basePath, string copy, params (string Question, string Answer)[] answers) =>
        _factory.CreateClient().PostAsJsonAsync("/api/answers",
            new AnswersRequest(basePath, copy, answers.Select(a => new OperatorAnswer(a.Question, a.Answer)).ToList()));

    public void Dispose()
    {
        _factory.Dispose();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
