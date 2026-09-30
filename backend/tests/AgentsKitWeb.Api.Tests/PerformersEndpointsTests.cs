using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Performers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class PerformersEndpointsTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-tests-").FullName;
    private readonly TestHosts _hosts = new();

    [Fact]
    public async Task Performers_ListsPerformersOfTheBaseWithTheirFields()
    {
        var basePath = CreateBase("app-knowledge");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");
        Performer(basePath, "reviewer", """
            ---
            name: reviewer
            description: Читает дифф ветки задачи и возвращает вердикт.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф ветки целиком.
            """);

        var performers = Assert.Single(await Get(basePath));

        Assert.Equal("Order Service", performers.Project);
        Assert.Equal(TestLayout.Agents(basePath), performers.Directory);
        Assert.Null(performers.Error);

        // Имя — то, которым зовёт исполнителя шаг флоу: приставки проекта у него больше нет.
        var reviewer = Assert.Single(performers.Performers);
        Assert.Equal("reviewer", reviewer.Name);
        Assert.Equal("Читает дифф ветки задачи и возвращает вердикт.", reviewer.Description);
        Assert.Equal("opus", reviewer.Model);
        Assert.Equal("Read, Glob, Grep", reviewer.Tools);
        Assert.Equal("Ты читаешь дифф ветки целиком.", reviewer.Prompt);
        Assert.Equal(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"), reviewer.Path);
    }

    [Fact]
    // Исполнители — в личном репозитории оператора этой машины. Каталог agents/ в корне базы — прежнее место кита,
    // папки операторов в people\ — выложенное для коллег (формат 6 кита), даже своя: их не видно.
    public async Task Performers_OnlyFromPersonalRepository()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        Directory.CreateDirectory(Path.Combine(basePath, "agents"));
        File.WriteAllText(Path.Combine(basePath, "agents", "old.md"), "---\nname: old\n---\n\nПрежнее место.\n");
        var colleague = Path.Combine(basePath, "people", "colleague", "agents");
        Directory.CreateDirectory(colleague);
        File.WriteAllText(Path.Combine(colleague, "theirs.md"), "---\nname: theirs\n---\n\nЧужой.\n");
        var published = Path.Combine(TestLayout.Published(basePath), "agents");
        Directory.CreateDirectory(published);
        File.WriteAllText(Path.Combine(published, "shared.md"), "---\nname: shared\n---\n\nВыложенный.\n");

        var performers = Assert.Single(await Get(basePath));

        Assert.Equal(["reviewer"], performers.Performers.Select(p => p.Name));
    }

    [Fact]
    public async Task Performers_ShowsThoseSetUpInTheBaseBesidesThePanel()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        // Заведён в базе руками, мимо панели: строка списка — это файл базы, и он в списке есть.
        Performer(basePath, "scout", "---\nname: scout\n---\n\nТело.\n");

        var performers = Assert.Single(await Get(basePath));

        Assert.Equal(["reviewer", "scout"], performers.Performers.Select(p => p.Name));
    }

    [Fact]
    public async Task Performers_EmptyWhenNothingIsSetUp()
    {
        var performers = Assert.Single(await Get(CreateBase("app-knowledge")));

        Assert.Empty(performers.Performers);
        Assert.Null(performers.Error);
        Assert.Null(performers.FormatWarning);
    }

    [Fact]
    // Исполнители базы нового формата видны, как были, с предупреждением (B-281).
    public async Task Performers_BaseOfNewerFormat_IsReadWithWarning()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        TestLayout.NewerFormat(basePath);

        var performers = Assert.Single(await Get(basePath));

        Assert.Null(performers.Error);
        Assert.Equal(["reviewer"], performers.Performers.Select(p => p.Name));
        Assert.Equal(AgentsKitWeb.Api.Bases.BaseLayout.NewerFormatWarning, performers.FormatWarning);
    }

    [Fact]
    public async Task Performers_WritesFileIntoPersonalRepositoryAndLeavesTheBaseAlone()
    {
        var basePath = CreateBase("app-knowledge");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Читает дифф ветки задачи.", "opus", "Read, Glob, Grep", "Ты читаешь дифф.", null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var file = Path.Combine(TestLayout.Agents(basePath), "reviewer.md");
        Assert.Equal(file, (await response.Content.ReadFromJsonAsync<PerformerSavedResponse>())!.Path);

        Assert.Equal("""
            ---
            name: reviewer
            description: Читает дифф ветки задачи.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф.

            """.ReplaceLineEndings("\n"), File.ReadAllText(file).ReplaceLineEndings("\n"));

        // Исполнитель уходит в личный репозиторий коммитом: сессии, которая его закоммитила бы, у панели нет.
        // Общая база от него не меняется.
        Assert.Empty(Status(TestLayout.Personal(basePath)));
        Assert.Contains("Исполнитель reviewer записан из панели", Run(TestLayout.Personal(basePath), "log", "-1", "--format=%s"));
        Assert.Empty(Status(basePath));
        Assert.Equal("база", Run(basePath, "log", "-1", "--format=%s").Trim());
    }

    [Fact]
    public async Task Performers_WritesNothingIntoWorkingCopies()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // В копию исполнителя развозит кит своим прогоном, а панель в неё не пишет и в ней не коммитит.
        Assert.False(Directory.Exists(Path.Combine(copy, ".claude")));
        Assert.Empty(Status(copy));
    }

    [Fact]
    public async Task Performers_EditingRewritesTheSameFile()
    {
        var basePath = CreateBase("app-knowledge");

        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Первое", null, null, "Тело", null));
        var second = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Второе", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var text = File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"));
        Assert.Contains("description: Второе", text);
        Assert.DoesNotContain("Первое", text);
        Assert.Single(Directory.GetFiles(TestLayout.Agents(basePath)));
    }

    [Fact]
    public async Task Performers_RefusesNameAlreadyTakenInTheBase()
    {
        var basePath = CreateBase("app-knowledge");
        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Первое", null, null, "Тело", null));

        var again = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Другой исполнитель", null, null, "Другое тело", null));

        // Молча переписать заведённого в базе — потерять его.
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("name-taken", (await again.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.Contains("Первое", File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    // Исполнителей базы нового формата панель не пишет (B-281).
    public async Task Performers_RefusesBaseOfNewerFormat()
    {
        var basePath = CreateBase("app-knowledge");
        TestLayout.NewerFormat(basePath);

        var response = await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Первое", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!;
        Assert.Equal(("newer-format", AgentsKitWeb.Api.Bases.BaseLayout.NewerFormatRefusal), (rejected.Problem, rejected.Detail));
        Assert.False(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_RefusesNameTakenByATrackedFileOfTheProject()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        Directory.CreateDirectory(Path.Combine(copy, ".claude", "agents"));
        File.WriteAllText(Path.Combine(copy, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\n\nСвой.\n");
        TestGit.Run(copy, "add", "--", ".claude/agents/reviewer.md");
        TestGit.Run(copy, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "агент проекта");
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        // Такой файл кит не трогает: исполнитель остался бы в базе, а в копию не приехал.
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!;
        Assert.Equal("name-in-project", rejected.Problem);
        Assert.Equal(copy, rejected.Detail);
        Assert.False(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_EditingOneNamedInsideTheFileLeavesOneFile()
    {
        var basePath = CreateBase("app-knowledge");
        // Заведён в базе руками: файл назван одним, а имя, которым его зовёт шаг флоу, записано внутри.
        Performer(basePath, "foo", "---\nname: reviewer\n---\n\nПервое тело.\n");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // Иначе в базе оказались бы два файла с одним именем, и в копию уехали бы оба.
        Assert.Equal(["reviewer.md"], Directory.GetFiles(TestLayout.Agents(basePath)).Select(Path.GetFileName));
        Assert.Empty(Status(TestLayout.Personal(basePath)));
    }

    [Fact]
    public async Task Performers_RefusesNameWrittenInsideAnotherFile()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "foo", "---\nname: reviewer\n---\n\nПервое тело.\n");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Другой исполнитель", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("name-taken", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_RefusesToOverwriteAFileWhoseNameIsWrittenInside()
    {
        var basePath = CreateBase("app-knowledge");
        // Файл назван reviewer.md, а зовут его исполнителя иначе: имя записано внутри файла.
        Performer(basePath, "reviewer", "---\nname: code-reviewer\n---\n\nЧужая работа.\n");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        // Иначе чужая работа молча ушла бы в историю базы под чужим именем.
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("name-taken", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.Contains("Чужая работа.", File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_EditingRefusesWhenTheTargetFileBelongsToAnother()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "foo", "---\nname: reviewer\n---\n\nПравимый.\n");
        Performer(basePath, "reviewer", "---\nname: code-reviewer\n---\n\nЧужая работа.\n");

        // Правят reviewer, имени не меняя, — но файл reviewer.md принадлежит другому исполнителю.
        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", "reviewer"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("name-taken", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.Contains("Чужая работа.", File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
        Assert.Contains("Правимый.", File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "foo.md")));
    }

    [Fact]
    public async Task Performers_RenamingLeavesOnlyTheNewFile()
    {
        var basePath = CreateBase("app-knowledge");
        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Описание", null, null, "Тело", null));

        var renamed = await Save(basePath, new SavePerformerRequest(
            basePath, "code-reviewer", "Описание", null, null, "Тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal(["code-reviewer.md"], Directory.GetFiles(TestLayout.Agents(basePath)).Select(Path.GetFileName));
        // Прежний файл уходит тем же коммитом: иначе база осталась бы с двумя одинаковыми исполнителями.
        Assert.Empty(Status(TestLayout.Personal(basePath)));
    }

    [Fact]
    public async Task Performers_RefusesNameThatIsNotASubagentName()
    {
        var basePath = CreateBase("app-knowledge");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "Ревью Диффа", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-name", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(Directory.Exists(TestLayout.Agents(basePath)));
    }

    [Theory]
    [InlineData("\n")]
    [InlineData("\r")]
    [InlineData("\u2028")]
    [InlineData("\u0085")]
    [InlineData("\u2029")]
    [InlineData("\f")]
    public async Task Performers_RefusesDescriptionThatSpansLines(string lineBreak)
    {
        // Описание — строка шапки файла: перевод строки в нём оборвал бы шапку.
        var basePath = CreateBase("app-knowledge");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", $"Читает дифф.{lineBreak}name: чужой", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-description", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(Directory.Exists(TestLayout.Agents(basePath)));
    }

    [Fact]
    public async Task Performers_KeepsNothingWhenTheBaseRefusesTheCommit()
    {
        // Личный репозиторий не принимает коммит: незакоммиченный исполнитель уехал бы в чужой коммит.
        var basePath = CreateBase("app-knowledge", git: false);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("not-committed", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_CommitRefusedByHook_RestoresTheFileAndLeavesNothingStaged()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nПервое тело.\n");
        TestGit.Run(TestLayout.Personal(basePath), "add", "--", "agents/reviewer.md");
        TestGit.Run(TestLayout.Personal(basePath), "commit", "-m", "исполнитель");
        File.WriteAllText(Path.Combine(TestLayout.Personal(basePath), ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'сверка: база не приняла' >&2\nexit 1\n");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!;
        Assert.Equal("not-committed", rejected.Problem);
        Assert.Contains("сверка: база не приняла", rejected.Detail);

        // Правимый исполнитель остался в базе, каким был, и отказанная правка не ждёт в индексе.
        Assert.Equal("Первое тело.", PerformerFile.Parse(File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"))).Prompt);
        Assert.Empty(Status(TestLayout.Personal(basePath)));
    }

    [Fact]
    public async Task Performers_EditingKeepsTheCaseOfTheFileName()
    {
        // Заведённый руками файл назван с заглавной: правка не должна сменить регистр имени на диске,
        // иначе он разойдётся с тем, что знает git.
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        Directory.CreateDirectory(TestLayout.Agents(basePath));
        File.WriteAllText(Path.Combine(TestLayout.Agents(basePath), "Reviewer.md"), "---\nname: reviewer\n---\n\nПервое тело.\n");
        TestGit.Run(personal, "add", "--", "agents/Reviewer.md");
        TestGit.Run(personal, "commit", "-m", "исполнитель");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(["Reviewer.md"], Directory.EnumerateFiles(TestLayout.Agents(basePath)).Select(f => Path.GetFileName(f)).ToArray());
        Assert.Equal("Другое тело", PerformerFile.Parse(File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "Reviewer.md"))).Prompt);
        Assert.Equal("agents/Reviewer.md", Run(personal, "ls-files").Trim());
        Assert.Empty(Status(personal));
    }

    [Fact]
    public async Task Performers_RequestAbortedWhileStaging_StillCommitsThePerformer()
    {
        // Вкладку закрыли, когда исполнитель уже записан и заносится в индекс: оборванная запись оставила
        // бы его в индексе без коммита, для чужого коммита соседней сессии.
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        var (started, release) = HoldStaging(personal);
        using var abort = new CancellationTokenSource();

        var saving = Factory(basePath).CreateClient().PostAsJsonAsync("/api/performers", new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null), abort.Token);
        await Until(() => File.Exists(started));
        abort.Cancel();
        File.WriteAllText(release, "");
        await Aborted(saving);

        await Until(() => Run(personal, "log", "-1", "--format=%s").Trim() == "Исполнитель reviewer записан из панели");
        Assert.Equal("Тело", PerformerFile.Parse(File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"))).Prompt);
        Assert.Empty(Status(personal));
    }

    [Fact]
    public async Task Performers_RequestAbortedWhileTheBaseRefusesTheCommit_RestoresTheFileAndLeavesNothingStaged()
    {
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nПервое тело.\n");
        TestGit.Run(personal, "add", "--", "agents/reviewer.md");
        TestGit.Run(personal, "commit", "-m", "исполнитель");
        var (started, release) = HoldCommit(personal);
        using var abort = new CancellationTokenSource();

        var saving = Factory(basePath).CreateClient().PostAsJsonAsync("/api/performers", new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Другое тело", "reviewer"), abort.Token);
        await Until(() => File.Exists(started));
        abort.Cancel();
        var file = Path.Combine(TestLayout.Agents(basePath), "reviewer.md");
        // Пока хук держит коммит, на месте исполнителя лежит правка; откат вернёт прежнее и опустошит индекс.
        Assert.Equal("Другое тело", PerformerFile.Parse(File.ReadAllText(file)).Prompt);
        File.WriteAllText(release, "");
        await Aborted(saving);

        await Until(() => PerformerFile.Parse(File.ReadAllText(file)).Prompt == "Первое тело." && Status(personal).Length == 0);
        Assert.Equal("исполнитель", Run(personal, "log", "-1", "--format=%s").Trim());
    }

    [Theory]
    [InlineData(null, "reviewer")]
    [InlineData("reviewer", "reviewer")]
    [InlineData("reviewer", "critic")]
    public async Task Performers_FileNotWritten_LeavesThePerformerAsItWas(string? editing, string name)
    {
        // Диск отказал посреди записи: недописанный файл не должен встать на место прежнего исполнителя.
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        var agents = TestLayout.Agents(basePath);
        var before = "---\nname: reviewer\n---\n\nПервое тело.\n";
        if (editing is not null)
        {
            Performer(basePath, "reviewer", before);
            TestGit.Run(personal, "add", "--", "agents/reviewer.md");
            TestGit.Run(personal, "commit", "-m", "исполнитель");
        }
        // Каталог на месте временного файла: запись срывается раньше, чем тронет файл исполнителя.
        Directory.CreateDirectory(Path.Combine(agents, name + ".md.panel-tmp"));

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, name, "Описание", null, null, "Другое тело", editing));

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var left = Directory.EnumerateFiles(agents).Select(f => Path.GetFileName(f)).ToArray();
        if (editing is null)
            Assert.Empty(left);
        else
        {
            Assert.Equal(["reviewer.md"], left);
            Assert.Equal(before, File.ReadAllText(Path.Combine(agents, "reviewer.md")));
        }
        Assert.Empty(Status(personal));
    }

    /// <summary>
    /// Хук личного репозитория держит коммит: отмечает начало файлом started и ждёт файла release, потом
    /// отказывает. Ждёт не дольше запаса тестов, чтобы упавший тест не оставил git висеть.
    /// </summary>
    private (string Started, string Release) HoldCommit(string personal)
    {
        var started = Path.Combine(_root, "commit-started");
        var release = Path.Combine(_root, "commit-release");
        File.WriteAllText(Path.Combine(personal, ".git", "hooks", "pre-commit"), $$"""
            #!/bin/sh
            touch '{{started.Replace('\\', '/')}}'
            i=0
            while [ ! -f '{{release.Replace('\\', '/')}}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
            echo 'сверка: база не приняла' >&2
            exit 1

            """.ReplaceLineEndings("\n"));
        return (started, release);
    }

    /// <summary>
    /// Фильтр личного репозитория держит git add файла исполнителя, как хук держит коммит. Коммит по пути
    /// прогоняет файл через фильтр ещё раз — к тому времени release уже лежит, и фильтр пропускает сразу.
    /// </summary>
    private (string Started, string Release) HoldStaging(string personal)
    {
        var started = Path.Combine(_root, "add-started");
        var release = Path.Combine(_root, "add-release");
        var filter = Path.Combine(_root, "hold.sh");
        File.WriteAllText(filter, $$"""
            #!/bin/sh
            touch '{{started.Replace('\\', '/')}}'
            i=0
            while [ ! -f '{{release.Replace('\\', '/')}}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
            cat

            """.ReplaceLineEndings("\n"));
        File.WriteAllText(Path.Combine(personal, ".git", "info", "attributes"), "agents/*.md filter=hold\n");
        TestGit.Run(personal, "config", "filter.hold.clean", $"sh '{filter.Replace('\\', '/')}'");
        return (started, release);
    }

    /// <summary>
    /// Оборванный запрос: тестовый сервер отдаёт клиенту отмену, только когда запрос отработал, поэтому хук
    /// отпускают раньше, чем ждут клиента.
    /// </summary>
    private static async Task Aborted(Task<HttpResponseMessage> saving) =>
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => saving);

    private static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!condition())
            await Task.Delay(50, deadline.Token);
    }

    [Fact]
    public async Task Performers_KeepsTheLineEndingsOfTheFileItRewrites()
    {
        var basePath = CreateBase("app-knowledge");
        // Пишется как есть, без приведения к LF: тест как раз про перевод строк прежнего файла.
        Directory.CreateDirectory(TestLayout.Agents(basePath));
        File.WriteAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"), "---\r\nname: reviewer\r\n---\r\n\r\nПервое тело.\r\n");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // Файл лежит в чужой базе под git: смена перевода строк дала бы коммит «изменился весь файл».
        var text = File.ReadAllText(Path.Combine(TestLayout.Agents(basePath), "reviewer.md"));
        Assert.Contains("\r\n", text);
        Assert.DoesNotContain("\n", text.Replace("\r\n", ""));
    }

    [Fact]
    public async Task Performers_DeleteRemovesTheFileInOneCommit()
    {
        var basePath = CreateBase("app-knowledge");
        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Описание", null, null, "Тело", null));
        await Save(basePath, new SavePerformerRequest(basePath, "designer", "Описание", null, null, "Тело", null));
        var personal = TestLayout.Personal(basePath);
        var before = Run(personal, "rev-list", "--count", "HEAD").Trim();

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(["designer.md"], Directory.GetFiles(TestLayout.Agents(basePath)).Select(Path.GetFileName));
        // Удаление — одна запись в истории базы, и в рабочем дереве после неё ничего не ждёт.
        Assert.Equal(int.Parse(before) + 1, int.Parse(Run(personal, "rev-list", "--count", "HEAD").Trim()));
        Assert.Equal("Исполнитель reviewer удалён из панели", Run(personal, "log", "-1", "--format=%s").Trim());
        Assert.Empty(Status(personal));
        Assert.Equal(["designer"], (await Get(basePath)).Single().Performers.Select(p => p.Name));
    }

    [Fact]
    public async Task Performers_DeleteFindsTheFileByTheNameWrittenInside()
    {
        var basePath = CreateBase("app-knowledge");
        // Заведён в базе руками и не закоммичен: файл назван одним, а зовут исполнителя другим именем.
        Performer(basePath, "foo", "---\nname: reviewer\n---\n\nТело.\n");

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.False(File.Exists(Path.Combine(TestLayout.Agents(basePath), "foo.md")));
        Assert.Empty(Status(TestLayout.Personal(basePath)));
    }

    [Fact]
    public async Task Performers_DeleteOfAnUnknownNameChangesNothing()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");

        var response = await Delete(basePath, "designer");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        // Назван отказ: окно отличает «исполнителя нет» от базы, которой нет в списке панели.
        Assert.Equal("no-performer", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.True(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Theory]
    // Исполнитель этапа и помощник оркестратора: этап, зовущий удалённого, агент бы не выполнил (B-83).
    [InlineData("# Дизайн\n\nисполнитель: reviewer\nвыход: макет\n")]
    [InlineData("# Дизайн\n\nисполнитель: оркестратор\nпомощники: scout, reviewer\nвыход: макет\n")]
    public async Task Performers_DeleteRefusesOneCalledByAStage(string stage)
    {
        var basePath = CreateBase("app-knowledge");
        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Описание", null, null, "Тело", null));
        Stage(basePath, "design", stage);

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!;
        Assert.Equal(("called-by-flow", "Дизайн"), (rejected.Problem, rejected.Detail));
        Assert.True(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_ListNamesTheStagesThatCallEachPerformer()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        Performer(basePath, "scout", "---\nname: scout\n---\n\nТело.\n");
        Stage(basePath, "design", "# Дизайн\n\nисполнитель: reviewer\nвыход: макет\n");
        Stage(basePath, "review", "# Ревью\n\nисполнитель: оркестратор\nпомощники: reviewer\nвыход: вердикт\n");

        var performers = (await Get(basePath)).Single().Performers;

        Assert.Equal(["Дизайн", "Ревью"], performers.Single(p => p.Name == "reviewer").CalledBy!);
        Assert.Empty(performers.Single(p => p.Name == "scout").CalledBy!);
    }

    [Fact]
    // Задача идёт по копии своего сценария рядом с памятью (кит формата 8): исполнитель, которого из флоу уже убрали,
    // ей ещё нужен, и удалить его нельзя, пока его зовёт копия идущей задачи любой машины — решение оператора на B-299.
    public async Task Performers_StageOfRunningTaskFlowCopyHoldsPerformer()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        Performer(basePath, "scout", "---\nname: scout\n---\n\nТело.\n");
        File.WriteAllText(TestLayout.Backlog(basePath), "следующий номер: B-9\n");
        var here = Path.Combine(TestLayout.Work(basePath), "d-app");
        Directory.CreateDirectory(Path.Combine(here, "flow", "stages"));
        File.WriteAllText(here + ".md", "# B-7 Правка окна\nрабочая копия: D:\\app\nсценарий: мелкий\n");
        File.WriteAllText(Path.Combine(here, "flow", "stages", "review.md"), "# Ревью\n\nисполнитель: reviewer\nвыход: вердикт\n");
        // Другая машина оператора, память без номера из бэклога — задача названа заголовком.
        var laptop = Path.Combine(TestLayout.Personal(basePath), "work", "laptop", "d-app");
        Directory.CreateDirectory(Path.Combine(laptop, "flow", "stages"));
        File.WriteAllText(laptop + ".md", "# Починить выгрузку\nрабочая копия: D:\\app\n");
        File.WriteAllText(Path.Combine(laptop, "flow", "stages", "design.md"),
            "# Дизайн\n\nисполнитель: оркестратор\nпомощники: reviewer\nвыход: макет\n");
        // Копия без памяти рядом — задача названа именем каталога.
        var orphan = Path.Combine(TestLayout.Work(basePath), "d-other");
        Directory.CreateDirectory(Path.Combine(orphan, "flow", "stages"));
        File.WriteAllText(Path.Combine(orphan, "flow", "stages", "merge.md"), "# Мерж\n\nисполнитель: reviewer\nвыход: sha\n");

        var performers = (await Get(basePath)).Single().Performers;
        var response = await Delete(basePath, "reviewer");

        Assert.Equal(
            ["Дизайн (Починить выгрузку)", "Мерж (d-other)", "Ревью (B-7)"],
            performers.Single(p => p.Name == "reviewer").CalledBy!.Order());
        Assert.Empty(performers.Single(p => p.Name == "scout").CalledBy!);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("called-by-flow", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.True(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_DeleteRefusesBaseOfNewerFormat()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        TestLayout.NewerFormat(basePath);

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("newer-format", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.True(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_DeleteRefusedByHook_RestoresTheFileAndLeavesNothingStaged()
    {
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nПервое тело.\n");
        var file = Path.Combine(TestLayout.Agents(basePath), "reviewer.md");
        var bytes = File.ReadAllBytes(file);
        TestGit.Run(personal, "add", "--", "agents/reviewer.md");
        TestGit.Run(personal, "commit", "-m", "исполнитель");
        File.WriteAllText(Path.Combine(personal, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'сверка: база не приняла' >&2\nexit 1\n");

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!;
        Assert.Equal("not-committed", rejected.Problem);
        Assert.Contains("сверка: база не приняла", rejected.Detail);
        // Исполнитель остался в базе, каким был, и отказанное удаление не ждёт в индексе.
        Assert.Equal(bytes, File.ReadAllBytes(file));
        Assert.Empty(Status(personal));
    }

    [Fact]
    public async Task Performers_DeleteAbortedWhileTheBaseRefusesTheCommit_RestoresTheFileAndLeavesNothingStaged()
    {
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nПервое тело.\n");
        TestGit.Run(personal, "add", "--", "agents/reviewer.md");
        TestGit.Run(personal, "commit", "-m", "исполнитель");
        var (started, release) = HoldCommit(personal);
        using var abort = new CancellationTokenSource();

        var deleting = Factory(basePath).CreateClient().DeleteAsync(
            $"/api/performers?base={Uri.EscapeDataString(basePath)}&name=reviewer", abort.Token);
        await Until(() => File.Exists(started));
        abort.Cancel();
        var file = Path.Combine(TestLayout.Agents(basePath), "reviewer.md");
        // Пока хук держит коммит, файла на месте нет; откат вернёт его и опустошит индекс.
        Assert.False(File.Exists(file));
        File.WriteAllText(release, "");
        await Aborted(deleting);

        await Until(() => File.Exists(file) && Status(personal).Length == 0);
        Assert.Equal("Первое тело.", PerformerFile.Parse(File.ReadAllText(file)).Prompt);
        Assert.Equal("исполнитель", Run(personal, "log", "-1", "--format=%s").Trim());
    }

    [Fact]
    public async Task Performers_DeleteRemovesEveryFileOfTheName()
    {
        var basePath = CreateBase("app-knowledge");
        var personal = TestLayout.Personal(basePath);
        // Два файла называют одно имя: один назван им, у другого оно записано внутри.
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nПервое.\n");
        Performer(basePath, "foo", "---\nname: reviewer\n---\n\nВторое.\n");
        TestGit.Run(personal, "add", "--", "agents/reviewer.md", "agents/foo.md");
        TestGit.Run(personal, "commit", "-m", "исполнители");

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        // Иначе исполнитель с этим именем остался бы в списке, хотя удаление «прошло».
        Assert.Empty((await Get(basePath)).Single().Performers);
        // Оба файла уходят одним коммитом: между двумя база стояла бы с половиной удаления.
        Assert.Equal(["Исполнитель reviewer удалён из панели", "исполнители"], Run(personal, "log", "-2", "--format=%s").Trim().Split('\n'));
        Assert.Empty(Status(personal));
    }

    [Fact]
    public async Task Performers_DeleteChangesNothingWhenGitIsSilent()
    {
        // Git не отвечает: не узнать, знает ли он файл, — и отслеживаемый ушёл бы с диска без коммита.
        var basePath = CreateBase("app-knowledge", git: false);
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");

        var response = await Delete(basePath, "reviewer");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("git-silent", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.True(File.Exists(Path.Combine(TestLayout.Agents(basePath), "reviewer.md")));
    }

    [Fact]
    public async Task Performers_StageWithoutTitleIsNamedByItsFile()
    {
        var basePath = CreateBase("app-knowledge");
        Performer(basePath, "reviewer", "---\nname: reviewer\n---\n\nТело.\n");
        // Заголовок без текста: ключи этапа читаются, а названия у него нет.
        Stage(basePath, "design", "# \n\nисполнитель: reviewer\nвыход: макет\n");

        var performer = (await Get(basePath)).Single().Performers.Single();

        // Пустое место в подсказке этап бы не нашло.
        Assert.Equal(["design"], performer.CalledBy!);
    }

    private static void Stage(string basePath, string slug, string text)
    {
        var directory = Path.Combine(TestLayout.Personal(basePath), "flow", "stages");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, slug + ".md"), text);
    }

    private static void Performer(string basePath, string name, string text)
    {
        var directory = TestLayout.Agents(basePath);
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, name + ".md"), text.ReplaceLineEndings("\n"));
    }

    private string CreateBase(string name, params string[] copies) => CreateBase(name, true, copies);

    /// <summary>
    /// База прогона под git и личный репозиторий, в который панель коммитит исполнителя; git: false — личный
    /// репозиторий коммита не примет: его .git указывает в никуда.
    /// </summary>
    private string CreateBase(string name, bool git, params string[] copies)
    {
        var basePath = TestLayout.Base(Path.Combine(_root, name), copies);
        var personal = TestLayout.Personal(basePath);
        if (!git)
        {
            Directory.Delete(Path.Combine(personal, ".git"), recursive: true);
            File.WriteAllText(Path.Combine(personal, ".git"), "gitdir: " + Path.Combine(_root, "gone.git") + "\n");
            return basePath;
        }

        TestGit.Run(personal, "config", "user.name", "t");
        TestGit.Run(personal, "config", "user.email", "t@t");

        TestGit.Run(basePath, "init", "-b", "main");
        TestGit.Run(basePath, "config", "user.name", "t");
        TestGit.Run(basePath, "config", "user.email", "t@t");
        TestGit.Run(basePath, "add", "--", "agents-kit.json", ".gitignore");
        TestGit.Run(basePath, "commit", "-m", "база");
        return basePath;
    }

    private static string[] Status(string copy) =>
        Run(copy, "status", "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray();

    private static string Run(string workingDirectory, params string[] args)
    {
        // Сообщения git по-русски: без UTF-8 вывод читается кодировкой консоли и не сходится.
        var startInfo = new System.Diagnostics.ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = TestProcess.Start(startInfo);
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return output.ReplaceLineEndings("\n");
    }

    private WebApplicationFactory<Program> Factory(params string[] bases) =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            })));

    private async Task<List<BasePerformers>> Get(params string[] bases)
    {
        var factory = Factory(bases);
        var response = await factory.CreateClient().GetAsync("/api/performers");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<List<BasePerformers>>() ?? [];
    }

    private async Task<HttpResponseMessage> Save(string basePath, SavePerformerRequest request)
    {
        var factory = Factory(basePath);
        return await factory.CreateClient().PostAsJsonAsync("/api/performers", request);
    }

    private async Task<HttpResponseMessage> Delete(string basePath, string name)
    {
        var factory = Factory(basePath);
        return await factory.CreateClient().DeleteAsync(
            $"/api/performers?base={Uri.EscapeDataString(basePath)}&name={Uri.EscapeDataString(name)}");
    }

    public void Dispose()
    {
        _hosts.Dispose();
        try
        {
            // Объекты git лежат read-only: без снятия атрибутов каталог прогона не удаляется.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Каталог прогона держит git — временные файлы уберёт система.
        }
        GC.SuppressFinalize(this);
    }
}
