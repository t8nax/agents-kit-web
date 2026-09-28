using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Tasks;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class TaskEndpointsTests : IDisposable
{
    private const string Backlog = """
        # Order Service — бэклог

        следующий номер: B-9

        ## B-7 Панель показывает задачу сразу

        Текст оператору.

        ### Агенту
        - где: App.tsx

        ## B-8 Кнопка запуска

        Текст оператору.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-tasks-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly string _base;
    private readonly string _copy;
    private readonly string _sessionsDir;
    private readonly FakeAgent _agent = new();
    private readonly FakeTime _time = new(new DateTimeOffset(2026, 9, 18, 12, 0, 0, TimeSpan.Zero));

    public TaskEndpointsTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), _copy);
        _sessionsDir = Path.Combine(_root, "sessions");
        Directory.CreateDirectory(_sessionsDir);
        File.WriteAllText(TestLayout.Backlog(_base), Backlog.ReplaceLineEndings("\n") + "\n");
    }

    [Fact]
    public async Task Start_LaunchesBackgroundDriveSessionInCopyAndReturnsItsId()
    {
        _agent.Lines = ["Starting background service…", "backgrounded · 7339dced"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("7339dced", (await response.Content.ReadFromJsonAsync<TaskStartResponse>())!.Session);

        var startInfo = _agent.StartInfo!;
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        // Просьба уходит после «--»: текст, начатый с «-», claude принял бы за флаг.
        // Настройками сессия оставлена в самой копии: без них claude уходит работать в отдельное дерево.
        // Режим «авто» задан явно, а указание работать через оболочку погашено — B-153.
        Assert.Equal(["--permission-mode", "auto", "--settings", """{"worktree":{"bgIsolation":"none"},"env":{"CLAUDE_CODE_THRIFTY_SONIC":"0"}}""", "--bg", "--", "/agents-kit:drive B-7"], startInfo.ArgumentList);
        // Панель не правит бэклог и не заводит память: и то и другое делает навык кита в этой сессии.
        Assert.Contains("B-7", File.ReadAllText(TestLayout.Backlog(_base)));
        Assert.Empty(Directory.EnumerateFiles(TestLayout.Work(_base)));
    }

    [Fact]
    // Задачу в базе нового формата взять можно: ради этого её и не гасят — B-281.
    public async Task Start_InBaseOfNewerFormat_LaunchesSession()
    {
        TestLayout.NewerFormat(_base);
        _agent.Lines = ["backgrounded · 7339dced"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("/agents-kit:drive B-7", _agent.StartInfo!.ArgumentList[^1]);
    }

    /// <summary>Переход в сессию копии ведёт по этой отметке: иначе «ту самую» сессию не узнать.</summary>
    [Fact]
    public async Task Start_RemembersTheSessionItStartedInTheCopy()
    {
        _agent.Lines = ["backgrounded \u00b7 7339dced"];

        await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        var remembered = new TaskSessions(TaskSessions.FileBeside(Path.Combine(_root, "panel", "bases.json")));
        Assert.Equal("7339dced", remembered.SessionIn(_copy));
    }

    [Fact]
    public async Task Start_TakesCyrillicNumberAsTheSameRecord()
    {
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "В-8"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("/agents-kit:drive B-8", _agent.StartInfo!.ArgumentList[^1]);
    }

    [Fact]
    public async Task Start_NamesChosenFlowToSessionAsItStandsInBase()
    {
        WriteFlows();
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7", " МЕЛКИЙ"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // Сессия берёт названный флоу и о нём не спрашивает: навык кита принимает флоу, названный словами.
        Assert.Equal("/agents-kit:drive B-7 флоу «мелкий»", _agent.StartInfo!.ArgumentList[^1]);
    }

    [Fact]
    public async Task Start_PassesOperatorWordsInTheSameRequestOnNewLine()
    {
        WriteFlows();
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks",
            new TaskStartRequest(_base, _copy, "B-7", "мелкий", "\n  Начни с API.\n\n- тесты «как есть»\n"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // Другого сообщения запущенной сессии панель не шлёт: слова идут той же просьбой, одним аргументом.
        // Отступ первой строки остаётся, пустые строки по краям — нет.
        Assert.Equal("/agents-kit:drive B-7 флоу «мелкий»\n\n  Начни с API.\n\n- тесты «как есть»", _agent.StartInfo!.ArgumentList[^1]);
    }

    [Fact]
    public async Task Start_RejectsWordsLongerThanLimit()
    {
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks",
            new TaskStartRequest(_base, _copy, "B-7", null, new string('с', TaskEndpoints.WordsLimit + 1)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("words-too-long", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_WithBlankWordsSendsRequestAsBefore()
    {
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7", null, " \n "));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("/agents-kit:drive B-7", _agent.StartInfo!.ArgumentList[^1]);
    }

    [Fact]
    public async Task Start_RejectsFlowBaseDoesNotHave()
    {
        WriteFlows();

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7", "срочный"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("flow-unknown", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    private void WriteFlows()
    {
        // Флоу — в папке оператора; тот же файл в корне базы, на прежнем месте кита, запуск не видит.
        Directory.CreateDirectory(Path.Combine(_base, "flow"));
        File.WriteAllText(Path.Combine(_base, "flow", "scenarios.md"), "# Прежнее место\n\n## срочный\nкогда: всегда\n1. [Ветка](stages/branch.md)\n");
        Directory.CreateDirectory(TestLayout.Flow(_base));
        File.WriteAllText(Path.Combine(TestLayout.Flow(_base), "scenarios.md"), """
            # App — сценарии

            ## полный
            когда: новая возможность
            1. [Ветка](stages/branch.md)

            ## мелкий
            когда: правка в одном месте
            1. [Ветка](stages/branch.md)
            """);
    }

    [Fact]
    public async Task Start_TakesNumberWithTheProjectsOwnLetters()
    {
        WriteBacklog("следующий номер: ORD-13\n\n## ORD-12 Выгрузка заказов\n");
        _agent.Lines = ["backgrounded · abc123"];

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "ord-12"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("/agents-kit:drive ORD-12", _agent.StartInfo!.ArgumentList[^1]);
    }

    /// <summary>Запись чужими буквами кит считает ошибкой и перенумерует: задачей панель её не запускает.</summary>
    [Fact]
    public async Task Start_RejectsRecordWithForeignLetters()
    {
        WriteBacklog("следующий номер: ORD-13\n\n## ORD-12 Выгрузка заказов\n\n## B-7 Чужими буквами\n");

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("record-unknown", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    private readonly FakeGitHubIssues _github = new();

    private sealed class FakeGitHubIssues : IGitHubIssues
    {
        public TrackerIssues Answer { get; set; } = new([]);

        public List<string> Asked { get; } = [];

        public Task<TrackerIssues> AssignedAsync(string repo, CancellationToken cancellationToken)
        {
            Asked.Add(repo);
            return Task.FromResult(Answer);
        }
    }

    private void WriteGitHubTracker() =>
        File.WriteAllText(Path.Combine(_base, "tracker.md"), "# Трекер\n\n## Где задачи\nhttps://github.com/acme/orders\n");

    /// <summary>Задачу трекера берёт навык кита по её имени, как кит её называет, — B-277.</summary>
    [Theory]
    [InlineData("GitHub #37")]
    [InlineData("github#37")]
    public async Task Start_TakesTrackerIssueByItsName(string name)
    {
        WriteGitHubTracker();
        _github.Answer = new TrackerIssues([new TrackerIssue("GitHub #37", 37, "Оплата падает", "https://github.com/acme/orders/issues/37")]);
        _agent.Lines = ["backgrounded · abc123"];
        var client = Client();

        var response = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, name));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(["acme/orders"], _github.Asked);
        Assert.Equal("/agents-kit:drive GitHub #37", _agent.StartInfo!.ArgumentList[^1]);
        var rows = await client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        Assert.Equal("GitHub #37 Оплата падает", Assert.Single(rows!, r => r.Path == _copy).Task);
    }

    /// <summary>Закрытую или назначенную не на оператора задачу панель не запускает — критерий B-277.</summary>
    [Fact]
    public async Task Start_RejectsTrackerIssueNotAssignedAndOpen()
    {
        WriteGitHubTracker();
        _github.Answer = new TrackerIssues([new TrackerIssue("GitHub #36", 36, "Другая", "https://github.com/acme/orders/issues/36")]);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "GitHub #37"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("issue-unknown", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>Окну — код причины, его оно называет словами; строку GitHub — только у причины без кода.</summary>
    [Theory]
    [InlineData(TrackerIssues.GhLogin, null, TrackerIssues.GhLogin)]
    [InlineData(TrackerIssues.RepoUnreachable, "GraphQL: Could not resolve to a Repository", TrackerIssues.RepoUnreachable)]
    [InlineData(TrackerIssues.GitHubError, "HTTP 502: Bad Gateway", "HTTP 502: Bad Gateway")]
    public async Task Start_TrackerUnreadable_SaysWhy(string problem, string? detail, string message)
    {
        WriteGitHubTracker();
        _github.Answer = new TrackerIssues([], problem, detail);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "GitHub #37"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new TaskStartProblem("tracker-unavailable", message), await response.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_TrackerIssueWithoutGitHubTracker_IsNotStarted()
    {
        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "GitHub #37"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new TaskStartProblem("tracker-unavailable", TrackerIssues.NoTracker), await response.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Empty(_github.Asked);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task CopyRow_CarriesTheProjectsLetters()
    {
        WriteBacklog("следующий номер: ORD-13\n\n## ORD-12 Выгрузка заказов\n");

        Assert.Equal("ORD", (await Row(Client())).Letters);
    }

    [Fact]
    public async Task Start_RejectsCopyThatAlreadyHasTaskMemory()
    {
        File.WriteAllText(Path.Combine(TestLayout.Work(_base), "app.md"), $"""
            # B-5 Прошлая задача
            рабочая копия: {_copy}
            ветка: dev
            """);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("copy-busy", problem!.Problem);
        Assert.Equal("B-5 Прошлая задача", problem.Message);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_RejectsSecondStartUntilMemoryAppears()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"))).StatusCode);
        _agent.StartInfo = null;

        var second = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-8"));

        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        var problem = await second.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("copy-starting", problem!.Problem);
        Assert.Equal("7339dced", problem.Message);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>Вторая копия того же проекта: запись, запущенная в первой, в неё не запускается — B-89.</summary>
    private string SecondCopy()
    {
        var second = TestGit.Repository(Path.Combine(_root, "app-second"));
        TestLayout.Machine(_base, TestLayout.Operator, _copy, second);
        return second;
    }

    [Fact]
    public async Task Start_RejectsRecordStillStartingInAnotherCopy()
    {
        var second = SecondCopy();
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"))).StatusCode);
        _agent.StartInfo = null;

        // Запись ещё в бэклоге — агент до неё не добрался, — а номер набран кириллицей.
        var again = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "в-7"));

        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        Assert.Equal(new TaskStartProblem("task-running", "app"), await again.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Null(_agent.StartInfo);

        // Другая запись в ту же вторую копию запускается.
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "B-8"))).StatusCode);
    }

    /// <summary>Два запуска одной задачи, пока первая сессия ещё заводится, — вторая не заводится (ревью B-89).</summary>
    [Fact]
    public async Task Start_RejectsSameTaskWhileItsSessionIsStillStarting()
    {
        var second = SecondCopy();
        var gate = new TaskCompletionSource();
        _agent.Gate = gate.Task;
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        var first = client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        while (_agent.StartInfo is null)
            await Task.Delay(10);
        var again = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "B-7"));
        gate.SetResult();

        Assert.Equal(new TaskStartProblem("task-running", "app"), await again.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Equal(HttpStatusCode.OK, (await first).StatusCode);
    }

    [Fact]
    public async Task Start_FreesTheTaskWhenClaudeDidNotStart()
    {
        var second = SecondCopy();
        _agent.Exit = new AgentExit(null, "Не удалось найти указанный файл");
        var client = Client();

        Assert.Equal("agent", (await (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7")))
            .Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        _agent.Exit = new AgentExit(0, "");
        _agent.Lines = ["backgrounded · 7339dced"];

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "B-7"))).StatusCode);
    }

    [Fact]
    public async Task Start_RejectsTaskWhoseMemoryIsInAnotherCopy()
    {
        var second = SecondCopy();
        // Запись осталась в бэклоге — дописана руками или вырезка не удалась, — а задача уже идёт в первой копии.
        File.WriteAllText(Path.Combine(TestLayout.Work(_base), "app.md"), $"""
            # B-7 Панель показывает задачу сразу
            рабочая копия: {_copy}
            ветка: dev
            """);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "B-7"));

        Assert.Equal(new TaskStartProblem("task-running", "app"), await response.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>Задача GitHub остаётся в трекере всё время работы: второй запуск отбивает память первой копии.</summary>
    [Fact]
    public async Task Start_RejectsTrackerIssueInWorkInAnotherCopy()
    {
        var second = SecondCopy();
        WriteGitHubTracker();
        _github.Answer = new TrackerIssues([new TrackerIssue("GitHub #37", 37, "Оплата падает", "https://github.com/acme/orders/issues/37")]);
        File.WriteAllText(Path.Combine(TestLayout.Work(_base), "app.md"), $"""
            # GitHub #37 Оплата падает
            рабочая копия: {_copy}
            ветка: dev
            """);

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, second, "github#37"));

        Assert.Equal(new TaskStartProblem("task-running", "app"), await response.Content.ReadFromJsonAsync<TaskStartProblem>());
        Assert.Null(_agent.StartInfo);
    }

    [Theory]
    [InlineData("B-7 Панель показывает задачу сразу", "B", "B-7")]
    [InlineData("в-7 Кириллицей", "B", "B-7")]
    [InlineData("GitHub #37 Оплата падает", "B", "GitHub #37")]
    [InlineData("github#037", null, "GitHub #37")]
    [InlineData("GitHub #37x Не номер", "B", null)]
    // Номером панель признаёт только номер буквами своего проекта — decisions/backlog-numbers.md
    [InlineData("UTF-8 в именах файлов", "B", null)]
    [InlineData("B-7 Буквы проекта не известны", null, null)]
    [InlineData("Задача без номера", "B", null)]
    [InlineData(null, "B", null)]
    public void TaskNumberOf_TakesNumberTheTaskStartsWith(string? task, string? letters, string? number) =>
        Assert.Equal(number, TaskEndpoints.TaskNumberOf(task, letters));

    [Fact]
    public async Task Start_RejectsNumberThatIsNotInBacklog()
    {
        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-99"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("record-unknown", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task Start_ReportsWhyClaudeDidNotStart()
    {
        _agent.Exit = new AgentExit(null, "Не удалось найти указанный файл");

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("Не удалось найти указанный файл", problem.Message);
    }

    [Fact]
    public async Task Start_ReportsClaudeThatSaidNoSessionId()
    {
        _agent.Lines = ["error: not logged in"];
        _agent.Exit = new AgentExit(1, "");

        var response = await Client().PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<TaskStartProblem>();
        Assert.Equal("agent", problem!.Problem);
        Assert.Equal("error: not logged in", problem.Message);
    }

    [Fact]
    public async Task Start_RejectsBaseOutsideListUnknownCopyAndBrokenNumber()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client();

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(other, _copy, "B-7"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, Path.Combine(_root, "gone"), "B-7"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "drive; rm -rf"))).StatusCode);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>
    /// Пока агент не завёл память, о задаче знает только панель: строка копии стоит её номером с заголовком
    /// записи и статусом «запускается», а кнопку «Взять задачу» фронт у такой копии не рисует.
    /// </summary>
    [Fact]
    public async Task StartedTask_ShowsInTheCopyRowBeforeTheAgentWritesItsMemory()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: true);

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Starting, row.Status);
        Assert.Equal("B-7 Панель показывает задачу сразу", row.Task);
        Assert.Null(row.FlowStep);
        Assert.Null(row.Progress);
        Assert.Empty(Directory.EnumerateFiles(TestLayout.Work(_base)));
    }

    /// <summary>Появилась память — строка живёт по ней, и отметка панели о запуске больше ничего не значит.</summary>
    [Fact]
    public async Task StartedTask_GivesWayToTheMemoryTheAgentWrote()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: true);
        WriteMemory("B-7 Задача, как её назвал агент");

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.InWork, row.Status);
        Assert.Equal("B-7 Задача, как её назвал агент", row.Task);
    }

    /// <summary>
    /// Сессия была в реестре и ушла, не заведя памяти — её погасили или она упала: копия снова
    /// свободна сразу, и задачу в неё запускают заново. Льгота первых секунд тут не при чём: она
    /// переживает только то время, пока сессию ещё ни разу не видели.
    /// </summary>
    [Fact]
    public async Task StartedTask_WhoseSessionIsGone_LeavesTheCopyFreeAgain()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        WriteSession("7339dced", live: true);
        Assert.Equal(WorkspaceStatus.Starting, (await Row(client)).Status);

        WriteSession("7339dced", live: false);

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Free, row.Status);
        Assert.Null(row.Task);

        _agent.StartInfo = null;
        var again = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-8"));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    /// <summary>
    /// В реестр живых сессий заведённая сессия попадает не одновременно с ответом запуска, а спустя
    /// десятые доли секунды, и первый опрос таблицы успевает пройти раньше. Пока сессии там нет,
    /// копия всё равно стоит «запускается»: иначе тот самый первый опрос стирал бы отметку насовсем,
    /// и запущенная задача в таблице не показывалась бы вовсе.
    /// </summary>
    [Fact]
    public async Task StartedTask_ShowsInTheCopyRow_WhileItsSessionHasNotReachedTheRegistry()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Starting, row.Status);
        Assert.Equal("B-7 Панель показывает задачу сразу", row.Task);
    }

    /// <summary>
    /// Сессия не появилась в реестре и за льготу — запуск сорвался, а сказать об этом нечем: копия
    /// снова свободна, и задачу в неё запускают заново.
    /// </summary>
    [Fact]
    public async Task StartedTask_WhoseSessionNeverReachedTheRegistry_LeavesTheCopyFreeAfterTheGrace()
    {
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-7"));
        Assert.Equal(WorkspaceStatus.Starting, (await Row(client)).Status);

        _time.Advance(TimeSpan.FromSeconds(11));

        var row = await Row(client);

        Assert.Equal(WorkspaceStatus.Free, row.Status);
        Assert.Null(row.Task);

        _agent.StartInfo = null;
        var again = await client.PostAsJsonAsync("/api/tasks", new TaskStartRequest(_base, _copy, "B-8"));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    /// <summary>Сессия задачи умерла, память цела: новая сессия продолжает задачу и становится сессией задачи.</summary>
    [Fact]
    public async Task ContinueSession_CopyWithTaskAndNoSession_StartsDriveWithoutNumberAndRemembersIt()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        _agent.Lines = ["backgrounded · 7339dced"];

        var response = await Client().PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("7339dced", (await response.Content.ReadFromJsonAsync<TaskStartResponse>())!.Session);
        Assert.Equal(["--permission-mode", "auto", "--settings", """{"worktree":{"bgIsolation":"none"},"env":{"CLAUDE_CODE_THRIFTY_SONIC":"0"}}""", "--bg", "--", "/agents-kit:drive"], _agent.StartInfo!.ArgumentList);
        Assert.Equal(_copy, _agent.StartInfo.WorkingDirectory);
        var remembered = new TaskSessions(TaskSessions.FileBeside(Path.Combine(_root, "panel", "bases.json")));
        Assert.Equal("7339dced", remembered.SessionIn(_copy));
    }

    [Fact]
    public async Task ContinueSession_StartedSessionIsTheRowsTaskSession()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();

        await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));
        WriteSession("7339dced", live: true);

        Assert.True((await Row(client)).BackgroundSession);
    }

    [Fact]
    public async Task ContinueSession_FreeCopy_IsRefusedWithoutStartingAnything()
    {
        var response = await Client().PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("no-task", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    [Fact]
    public async Task ContinueSession_TaskSessionAlive_IsRefused()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();
        await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));
        WriteSession("7339dced", live: true);
        _agent.StartInfo = null;

        var response = await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("session-alive", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>Сессия VS Code копии тоже читает ответ и ведёт задачу — вторая рядом с ней не нужна.</summary>
    [Fact]
    public async Task ContinueSession_VsCodeSessionAlive_IsRefused()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{Environment.ProcessId}.json"),
            JsonSerializer.Serialize(new
            {
                pid = Environment.ProcessId,
                cwd = _copy,
                entrypoint = "claude-vscode",
                procStart = Process.GetCurrentProcess().StartTime.ToFileTimeUtc().ToString(),
            }));

        var response = await Client().PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("session-alive", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);
    }

    /// <summary>Заведённая сессия ещё не в реестре — повторный запрос не заводит вторую рядом с ней.</summary>
    [Fact]
    public async Task ContinueSession_RepeatedBeforeSessionReachedRegistry_IsRefusedUntilTheGraceEnds()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        _agent.Lines = ["backgrounded · 7339dced"];
        var client = Client();
        await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));
        _agent.StartInfo = null;

        var again = await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        Assert.Equal("session-starting", (await again.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        Assert.Null(_agent.StartInfo);

        _time.Advance(ResumedSessions.Grace);
        var later = await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));
        Assert.Equal(HttpStatusCode.OK, later.StatusCode);
    }

    [Fact]
    public async Task ContinueSession_AgentFailed_SaysSoAndCanBeRepeatedAtOnce()
    {
        WriteMemory("B-7 Панель показывает задачу сразу");
        _agent.Lines = ["Error: not logged in"];
        _agent.Exit = new(1, "");
        var client = Client();

        var response = await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("agent", (await response.Content.ReadFromJsonAsync<TaskStartProblem>())!.Problem);
        var remembered = new TaskSessions(TaskSessions.FileBeside(Path.Combine(_root, "panel", "bases.json")));
        Assert.Null(remembered.SessionIn(_copy));

        _agent.Lines = ["backgrounded · 7339dced"];
        _agent.Exit = new(0, "");
        var again = await client.PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(_base, _copy));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    [Fact]
    public async Task ContinueSession_UnknownBase_IsNotFound()
    {
        var response = await Client().PostAsJsonAsync("/api/tasks/session", new TaskSessionRequest(Path.Combine(_root, "other"), _copy));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    public void Dispose()
    {
        _hosts.Dispose();
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private async Task<WorkspaceRow> Row(HttpClient client)
    {
        var rows = await client.GetFromJsonAsync<List<WorkspaceRow>>("/api/workspaces");
        return Assert.Single(rows!, row => row.Path == _copy);
    }

    private void WriteBacklog(string text) => File.WriteAllText(TestLayout.Backlog(_base), text);

    /// <summary>Память задачи, какой её завёл агент: копия занята, и строка идёт уже из неё.</summary>
    private void WriteMemory(string task) =>
        File.WriteAllText(Path.Combine(TestLayout.Work(_base), "app.md"), string.Join('\n', [
            "# " + task,
            "рабочая копия: " + _copy,
            "ветка: feat/row",
        ]));

    /// <summary>
    /// Запись реестра о фоновой сессии копии. Живой её делает номер процесса прогона: панель сверяет
    /// время старта, и запись с чужим временем считается брошенной.
    /// </summary>
    private void WriteSession(string jobId, bool live)
    {
        var procStart = Process.GetCurrentProcess().StartTime.ToFileTimeUtc() + (live ? 0 : 1);
        File.WriteAllText(
            Path.Combine(_sessionsDir, $"{Environment.ProcessId}.json"),
            JsonSerializer.Serialize(new
            {
                pid = Environment.ProcessId,
                cwd = _copy,
                entrypoint = "cli",
                kind = "bg",
                jobId,
                status = "busy",
                procStart = procStart.ToString(),
            }));
    }

    private HttpClient Client() =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, _base)),
                    new("SessionsDir", _sessionsDir),
                ]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и что делает с ответом.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentProcess>();
                services.AddSingleton<IAgentProcess>(_agent);
                services.RemoveAll<IGitHubIssues>();
                services.AddSingleton<IGitHubIssues>(_github);
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(_time);
            });
        })).CreateClient();

    /// <summary>Часы прогона: льгота отметки о запуске отмеряется ими, а не настоящим временем.</summary>
    private sealed class FakeTime(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public void Advance(TimeSpan span) => _now += span;

        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class FakeAgent : IAgentProcess
    {
        public IReadOnlyList<string> Lines { get; set; } = [];
        public AgentExit Exit { get; set; } = new(0, "");
        public ProcessStartInfo? StartInfo { get; set; }

        /// <summary>Пока не завершится, запуск висит — как `claude --bg`, который идёт секунды.</summary>
        public Task Gate { get; set; } = Task.CompletedTask;

        public async Task<AgentExit> RunAsync(
            ProcessStartInfo startInfo, string input, Func<string, Task> onLine, CancellationToken cancellationToken)
        {
            StartInfo = startInfo;
            await Gate;
            foreach (var line in Lines)
                await onLine(line);
            return Exit;
        }
    }
}
