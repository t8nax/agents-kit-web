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
        Assert.Equal(Path.Combine(basePath, "agents"), performers.Directory);
        Assert.Null(performers.Error);

        // Имя — то, которым зовёт исполнителя шаг флоу: приставки проекта у него больше нет.
        var reviewer = Assert.Single(performers.Performers);
        Assert.Equal("reviewer", reviewer.Name);
        Assert.Equal("Читает дифф ветки задачи и возвращает вердикт.", reviewer.Description);
        Assert.Equal("opus", reviewer.Model);
        Assert.Equal("Read, Glob, Grep", reviewer.Tools);
        Assert.Equal("Ты читаешь дифф ветки целиком.", reviewer.Prompt);
        Assert.Equal(Path.Combine(basePath, "agents", "reviewer.md"), reviewer.Path);
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
    }

    [Fact]
    public async Task Performers_WritesFileIntoTheBaseAndCommitsIt()
    {
        var basePath = CreateBase("app-knowledge");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Читает дифф ветки задачи.", "opus", "Read, Glob, Grep", "Ты читаешь дифф.", null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var file = Path.Combine(basePath, "agents", "reviewer.md");
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

        // Исполнитель уходит в базу коммитом: сессии, которая его закоммитила бы, у панели нет.
        Assert.Empty(Status(basePath));
        Assert.Contains("Исполнитель reviewer записан из панели", Run(basePath, "log", "-1", "--format=%s"));
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
        var text = File.ReadAllText(Path.Combine(basePath, "agents", "reviewer.md"));
        Assert.Contains("description: Второе", text);
        Assert.DoesNotContain("Первое", text);
        Assert.Single(Directory.GetFiles(Path.Combine(basePath, "agents")));
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
        Assert.Contains("Первое", File.ReadAllText(Path.Combine(basePath, "agents", "reviewer.md")));
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
        Assert.False(File.Exists(Path.Combine(basePath, "agents", "reviewer.md")));
    }

    [Fact]
    public async Task Performers_RenamingLeavesOnlyTheNewFile()
    {
        var basePath = CreateBase("app-knowledge");
        await Save(basePath, new SavePerformerRequest(basePath, "reviewer", "Описание", null, null, "Тело", null));

        var renamed = await Save(basePath, new SavePerformerRequest(
            basePath, "code-reviewer", "Описание", null, null, "Тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal(["code-reviewer.md"], Directory.GetFiles(Path.Combine(basePath, "agents")).Select(Path.GetFileName));
        // Прежний файл уходит тем же коммитом: иначе база осталась бы с двумя одинаковыми исполнителями.
        Assert.Empty(Status(basePath));
    }

    [Fact]
    public async Task Performers_RefusesNameThatIsNotASubagentName()
    {
        var basePath = CreateBase("app-knowledge");

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "Ревью Диффа", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-name", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(Directory.Exists(Path.Combine(basePath, "agents")));
    }

    [Fact]
    public async Task Performers_KeepsNothingWhenTheBaseRefusesTheCommit()
    {
        // База не под git: коммит не пройдёт, и незакоммиченный исполнитель уехал бы в чужой коммит.
        var basePath = CreateBase("app-knowledge", git: false);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("not-committed", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(File.Exists(Path.Combine(basePath, "agents", "reviewer.md")));
    }

    private static void Performer(string basePath, string name, string text)
    {
        var directory = Path.Combine(basePath, "agents");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, name + ".md"), text.ReplaceLineEndings("\n"));
    }

    private string CreateBase(string name, params string[] copies) => CreateBase(name, true, copies);

    /// <summary>База прогона: маркер кита и, когда нужно, git — панель коммитит исполнителя в неё.</summary>
    private string CreateBase(string name, bool git, params string[] copies)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        var json = System.Text.Json.JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies });
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), json);
        if (!git)
            return basePath;

        TestGit.Run(basePath, "init", "-b", "main");
        TestGit.Run(basePath, "config", "user.name", "t");
        TestGit.Run(basePath, "config", "user.email", "t@t");
        TestGit.Run(basePath, "add", "--", "agents-kit.json");
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
        using var process = System.Diagnostics.Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return output.ReplaceLineEndings("\n");
    }

    private WebApplicationFactory<Program> Factory(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            }));

    private async Task<List<BasePerformers>> Get(params string[] bases)
    {
        await using var factory = Factory(bases);
        var response = await factory.CreateClient().GetAsync("/api/performers");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<List<BasePerformers>>() ?? [];
    }

    private async Task<HttpResponseMessage> Save(string basePath, SavePerformerRequest request)
    {
        await using var factory = Factory(basePath);
        return await factory.CreateClient().PostAsJsonAsync("/api/performers", request);
    }

    public void Dispose()
    {
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
