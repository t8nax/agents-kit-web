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
    private readonly FakeTerminalWindows _terminals = new();
    private readonly WebApplicationFactory<Program> _factory;
    private int _sessionFiles;

    private const string Sections = """
        ## Критерии закрытия

        ### 1. Окно есть
        Оператор отвечает из панели.

        ### Не входит
        Health баз.

        ## Артефакты
        - макет окна: https://claude.ai/artifact/AbC123
        - спецификация: docs/spec.md
        - черновик: docs/gone.md
        - отчёт: docs/R&D.md
        - макеты: design
        - снимок: artifacts/B-1-снимок.png
        - побег: artifacts/../product.md

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
                services.RemoveAll<ITerminalWindows>();
                services.AddSingleton<ITerminalWindows>(_terminals);
            });
        });
    }

    [Fact]
    public async Task Questions_ReturnsUnansweredQuestionsWithTaskAndCriteria()
    {
        var response = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.NotNull(response);
        Assert.Equal("App", response.Project);
        Assert.Equal("feat/x", response.Branch);
        Assert.Equal("Окно ответа", response.Task);
        Assert.Equal([new ClosingCriterion("1. Окно есть", "Оператор отвечает из панели.")], response.Criteria);
        Assert.Equal("Health баз.", response.OutOfScope);
        Assert.Equal(
            [
                new TaskArtifact("макет окна", "https://claude.ai/artifact/AbC123"),
                new TaskArtifact("спецификация", "docs/spec.md"),
                new TaskArtifact("черновик", "docs/gone.md"),
                new TaskArtifact("отчёт", "docs/R&D.md"),
                new TaskArtifact("макеты", "design"),
                new TaskArtifact("снимок", "artifacts/B-1-снимок.png"),
                new TaskArtifact("побег", "artifacts/../product.md"),
            ],
            response.Artifacts);
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
    public async Task Answers_AttachedFileGoesToBaseArtifactsAndItsAddressIntoAnswer()
    {
        var response = await PostAnswers(_base, _copy,
            new OperatorAnswer("Подтвердить критерий?", "принимаю", [File64("Снимок экрана.png", 3)]),
            new OperatorAnswer("Как быть с переносами?", "", [File64("лог.txt", 1), File64("лог.txt", 2)]));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var memory = WorkMemory.Parse(await File.ReadAllTextAsync(_memoryPath));
        Assert.Equal(
            ["принимаю — файл: artifacts/Снимок-экрана.png", "файлы: artifacts/лог.txt, artifacts/лог-2.txt", "да"],
            memory.Questions.Select(q => q.Answer));
        Assert.Equal([0, 1, 2], File.ReadAllBytes(Path.Combine(_base, "artifacts", "Снимок-экрана.png")));
        Assert.Equal([0, 1], File.ReadAllBytes(Path.Combine(_base, "artifacts", "лог-2.txt")));
        Assert.False(Directory.Exists(Path.Combine(_copy, "artifacts")));
    }

    [Fact]
    public async Task Answers_TooLargeFile_IsRefusedAndWritesNothing()
    {
        var before = await File.ReadAllTextAsync(_memoryPath);

        var response = await PostAnswers(_base, _copy,
            new OperatorAnswer("Подтвердить критерий?", "принимаю", [File64("видео.mp4", 5 * 1024 * 1024 + 1)]),
            new OperatorAnswer("Как быть с переносами?", "пробелами"));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal(new AttachRejected("видео.mp4", "too-large"), await response.Content.ReadFromJsonAsync<AttachRejected>());
        Assert.Equal(before, await File.ReadAllTextAsync(_memoryPath));
        Assert.False(Directory.Exists(Path.Combine(_base, "artifacts")));
    }

    [Fact]
    public async Task Answers_RejectedAnswersTakeTheirFilesAway()
    {
        var response = await PostAnswers(_base, _copy,
            new OperatorAnswer("Подтвердить критерий?", "принимаю", [File64("снимок.png", 3)]),
            new OperatorAnswer("Старый вопрос?", "ещё раз"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_base, "artifacts")));
    }

    private static AttachedFile File64(string name, int length) =>
        new(name, Convert.ToBase64String(Enumerable.Range(0, length).Select(i => (byte)i).ToArray()));

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

    [Fact]
    public async Task OpenTerminal_SessionThePanelStarted_AttachesToItById()
    {
        var free = FreeCopy();
        WriteBackgroundSession(free, "7339dced");
        StartedByPanel(free, "7339dced");

        var response = await PostOpenTerminal(_base, free);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(free, "7339dced")], _terminals.Attached);
    }

    /// <summary>
    /// Отметка о запуске лежит в файле профиля, а не в памяти процесса: сессия переживает панель,
    /// и переход в неё есть и после её перезапуска.
    /// </summary>
    [Fact]
    public async Task OpenTerminal_PanelRestartedSinceTheStart_StillAttaches()
    {
        WriteBackgroundSession(_copy, "a1b2c3d4");
        StartedByPanel(_copy, "a1b2c3d4");

        var response = await PostOpenTerminal(_base, _copy);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(_copy, "a1b2c3d4")], _terminals.Attached);
    }

    /// <summary>Сессию, заведённую оператором в терминале, панель задачей копии не считает.</summary>
    [Fact]
    public async Task OpenTerminal_SessionStartedOutsideThePanel_IsRejectedAndOpensNothing()
    {
        WriteBackgroundSession(_copy, "a1b2c3d4");

        var response = await PostOpenTerminal(_base, _copy);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(_terminals.Attached);
    }

    /// <summary>Сессия запуска умерла — переходить некуда, даже если в копии работает другая.</summary>
    [Fact]
    public async Task OpenTerminal_StartedSessionIsGone_IsRejectedAndOpensNothing()
    {
        WriteBackgroundSession(_copy, "a1b2c3d4");
        StartedByPanel(_copy, "7339dced");

        var response = await PostOpenTerminal(_base, _copy);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(_terminals.Attached);
    }

    [Fact]
    public async Task OpenTerminal_OnlyVsCodeSessionInCopy_IsRejectedAndOpensNothing()
    {
        WriteSession(_copy);

        var response = await PostOpenTerminal(_base, _copy);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(new OpenSessionFailedResponse("no-session"), await response.Content.ReadFromJsonAsync<OpenSessionFailedResponse>());
        Assert.Empty(_terminals.Attached);
    }

    [Fact]
    public async Task OpenTerminal_TerminalDidNotOpen_IsBadGateway()
    {
        WriteBackgroundSession(_copy, "7339dced");
        StartedByPanel(_copy, "7339dced");
        _terminals.Result = false;

        var response = await PostOpenTerminal(_base, _copy);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal(new OpenSessionFailedResponse("not-opened"), await response.Content.ReadFromJsonAsync<OpenSessionFailedResponse>());
    }

    [Fact]
    public async Task OpenTerminal_CopyOutsideBase_IsNotFoundAndOpensNothing()
    {
        var outsider = Path.Combine(_root, "nope");
        WriteBackgroundSession(outsider, "7339dced");
        StartedByPanel(outsider, "7339dced");

        var response = await PostOpenTerminal(_base, outsider);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_terminals.Attached);
    }

    /// <summary>
    /// Сессий в копии бывает несколько — брошенная, заведённая вручную, ведущая задачу, — и переход
    /// ведёт в ту, которую панель тут запустила.
    /// </summary>
    [Fact]
    public async Task OpenTerminal_SeveralBackgroundSessionsInCopy_AttachesToTheStartedOne()
    {
        var free = FreeCopy();
        WriteBackgroundSession(free, "outsider", status: "waiting");
        WriteBackgroundSession(free, "thetask0", status: "busy");
        StartedByPanel(free, "thetask0");

        var response = await PostOpenTerminal(_base, free);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(free, "thetask0")], _terminals.Attached);
    }

    /// <summary>Кнопка окна ответа зовёт тот же переход, поэтому и она приводит в ту же сессию.</summary>
    [Fact]
    public async Task Questions_SeveralBackgroundSessionsInCopy_ItsTerminalButtonLeadsToTheStartedOne()
    {
        WriteBackgroundSession(_copy, "outsider", status: "idle");
        WriteBackgroundSession(_copy, "thetask0", status: "busy");
        StartedByPanel(_copy, "thetask0");

        var questions = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));
        await PostOpenTerminal(_base, _copy);

        Assert.True(questions!.BackgroundSession);
        Assert.Equal([(_copy, "thetask0")], _terminals.Attached);
    }

    [Fact]
    public async Task Questions_TellsWhetherTheCopyHasTheStartedSession()
    {
        WriteBackgroundSession(_copy, "7339dced");
        var before = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));
        StartedByPanel(_copy, "7339dced");
        var after = await _factory.CreateClient().GetFromJsonAsync<QuestionsResponse>(QuestionsUrl(_base, _copy));

        Assert.False(before!.BackgroundSession);
        Assert.True(after!.BackgroundSession);
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

    [Fact]
    public async Task OpenArtifact_OpensFileFromMemoryInCopyWindow()
    {
        var spec = Path.Combine(_copy, "docs", "spec.md");
        Directory.CreateDirectory(Path.GetDirectoryName(spec)!);
        File.WriteAllText(spec, "# спецификация");

        var response = await PostOpenArtifact(_base, _copy, 1);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(_copy, spec)], _windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_FileNotOnDisk_IsMissing()
    {
        var response = await PostOpenArtifact(_base, _copy, 2);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("missing", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_LinkToSite_IsNotOpenedByPanel()
    {
        var response = await PostOpenArtifact(_base, _copy, 0);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("not-a-file", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(7)]
    public async Task OpenArtifact_UnknownIndex_IsNotFound(int index)
    {
        var response = await PostOpenArtifact(_base, _copy, index);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_PathWithCmdMetacharacters_IsNotPassedToEditor()
    {
        var report = Path.Combine(_copy, "docs", "R&D.md");
        Directory.CreateDirectory(Path.GetDirectoryName(report)!);
        File.WriteAllText(report, "# отчёт");

        var response = await PostOpenArtifact(_base, _copy, 3);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("unsafe-path", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_Folder_OpensItsOwnWindow()
    {
        var design = Path.Combine(_copy, "design");
        Directory.CreateDirectory(design);

        var response = await PostOpenArtifact(_base, _copy, 4);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([design], _windows.Opened);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_FromBaseArtifacts_OpensFileOfBaseInCopyWindow()
    {
        // Кит держит файлы артефактов в artifacts/ базы, а ссылается на них путём от её корня.
        var shot = Path.Combine(_base, "artifacts", "B-1-снимок.png");
        Directory.CreateDirectory(Path.GetDirectoryName(shot)!);
        File.WriteAllBytes(shot, [1, 2, 3]);
        Directory.CreateDirectory(Path.Combine(_copy, "artifacts"));
        File.WriteAllBytes(Path.Combine(_copy, "artifacts", "B-1-снимок.png"), [4]);

        var response = await PostOpenArtifact(_base, _copy, 5);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([(_copy, shot)], _windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_FromBaseArtifactsNotOnDisk_IsMissing()
    {
        var response = await PostOpenArtifact(_base, _copy, 5);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("missing", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
    }

    [Fact]
    public async Task OpenArtifact_LeavingBaseArtifacts_IsNotOpened()
    {
        var response = await PostOpenArtifact(_base, _copy, 6);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("unsafe-path", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_AddressChangedSinceWindowOpened_IsNotFound()
    {
        var spec = Path.Combine(_copy, "docs", "spec.md");
        Directory.CreateDirectory(Path.GetDirectoryName(spec)!);
        File.WriteAllText(spec, "# спецификация");

        // под номером 1 в памяти теперь другой артефакт, чем видело окно
        var response = await PostOpenArtifact(_base, _copy, 1, "docs/old.md");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_BaseOutsidePanelList_IsNotFound()
    {
        var response = await PostOpenArtifact(Path.Combine(_root, "other-knowledge"), _copy, 1);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_windows.OpenedFiles);
    }

    [Fact]
    public async Task OpenArtifact_EditorFailed_IsBadGateway()
    {
        var spec = Path.Combine(_copy, "docs", "spec.md");
        Directory.CreateDirectory(Path.GetDirectoryName(spec)!);
        File.WriteAllText(spec, "# спецификация");
        _windows.Result = false;

        var response = await PostOpenArtifact(_base, _copy, 1);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("not-opened", (await response.Content.ReadFromJsonAsync<OpenArtifactFailedResponse>())!.Problem);
    }

    // Отметка панели о том, что сессию задачи в этой копии завела она сама.
    private void StartedByPanel(string copy, string session) => TestBases.TaskSession(_root, copy, session);

    private Task<HttpResponseMessage> PostOpenSession(string basePath, string copy) =>
        _factory.CreateClient().PostAsJsonAsync("/api/session/open", new OpenSessionRequest(basePath, copy));

    private Task<HttpResponseMessage> PostOpenWorkspace(string basePath, string copy) =>
        _factory.CreateClient().PostAsJsonAsync("/api/workspace/open", new OpenWorkspaceRequest(basePath, copy));

    private static readonly string[] ArtifactAddresses = ["https://claude.ai/artifact/AbC123", "docs/spec.md", "docs/gone.md", "docs/R&D.md", "design",
        "artifacts/B-1-снимок.png", "artifacts/../product.md"];

    private Task<HttpResponseMessage> PostOpenArtifact(string basePath, string copy, int index, string? address = null) =>
        _factory.CreateClient().PostAsJsonAsync("/api/artifact/open", new OpenArtifactRequest(
            basePath, copy, index, address ?? (index >= 0 && index < ArtifactAddresses.Length ? ArtifactAddresses[index] : "docs/spec.md")));

    private Task<HttpResponseMessage> PostOpenTerminal(string basePath, string copy) =>
        _factory.CreateClient().PostAsJsonAsync("/api/session/terminal", new OpenSessionRequest(basePath, copy));

    // Фоновая сессия — та же запись реестра, но с kind=bg и коротким id, которым в неё входят.
    private void WriteBackgroundSession(string cwd, string jobId, string? status = null) =>
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{++_sessionFiles}.json"),
            $$"""{"pid":{{Environment.ProcessId}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"cli","kind":"bg","jobId":"{{jobId}}"{{(status is null ? "" : $",\"status\":\"{status}\"")}}}""");

    // Живой сессией считается та, чей процесс существует, поэтому в фикстуре стоит pid самого прогона.
    private void WriteSession(string cwd, string entrypoint = "claude-vscode") =>
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{++_sessionFiles}.json"),
            $$"""{"pid":{{Environment.ProcessId}},"cwd":{{JsonSerializer.Serialize(cwd)}},"entrypoint":"{{entrypoint}}"}""");

    private sealed class FakeTerminalWindows : ITerminalWindows
    {
        public List<(string Copy, string Session)> Attached { get; } = [];

        public bool Result { get; set; } = true;

        public Task<bool> AttachAsync(string copyPath, string sessionId, CancellationToken cancellationToken)
        {
            Attached.Add((copyPath, sessionId));
            return Task.FromResult(Result);
        }
    }

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

        public List<(string Folder, string File)> OpenedFiles { get; } = [];

        public Task<bool> OpenFileAsync(string folder, string file, CancellationToken cancellationToken)
        {
            OpenedFiles.Add((folder, file));
            return Task.FromResult(Result);
        }
    }

    private Task<HttpResponseMessage> PostAnswers(string basePath, string copy, params (string Question, string Answer)[] answers) =>
        _factory.CreateClient().PostAsJsonAsync("/api/answers",
            new AnswersRequest(basePath, copy, answers.Select(a => new OperatorAnswer(a.Question, a.Answer)).ToList()));

    private Task<HttpResponseMessage> PostAnswers(string basePath, string copy, params OperatorAnswer[] answers) =>
        _factory.CreateClient().PostAsJsonAsync("/api/answers", new AnswersRequest(basePath, copy, answers));

    public void Dispose()
    {
        TestHost.Stop(_factory);
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
