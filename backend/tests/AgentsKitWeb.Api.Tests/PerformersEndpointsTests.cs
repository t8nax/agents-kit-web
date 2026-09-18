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
    public async Task Performers_ListsCopyAndProfileWithTheirFields()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        Performer(copy, "reviewer", """
            ---
            name: reviewer
            description: Читает дифф ветки задачи и возвращает вердикт.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф ветки целиком.
            """);
        var claudeDir = Path.Combine(_root, "profile");
        Performer(claudeDir, "spec-writer", "---\nname: spec-writer\ndescription: Пишет спеку экрана.\n---\n\nТело.\n");

        var basePath = CreateBase("app-knowledge", copy);
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");

        var performers = Assert.Single(await Get(claudeDir, basePath));

        Assert.Equal("Order Service", performers.Project);
        Assert.Null(performers.Error);

        var fromCopy = Assert.Single(performers.Performers, p => p.Name == "reviewer");
        Assert.Equal("Читает дифф ветки задачи и возвращает вердикт.", fromCopy.Description);
        Assert.Equal("opus", fromCopy.Model);
        Assert.Equal("Read, Glob, Grep", fromCopy.Tools);
        Assert.Equal("copy", fromCopy.Source);
        Assert.Equal(copy, fromCopy.Copy);
        Assert.Equal(Path.Combine(copy, ".claude", "agents", "reviewer.md"), fromCopy.Path);

        // Исполнителей профиля панель показывает, чтобы шаг флоу не считал их пропавшими.
        var fromProfile = Assert.Single(performers.Performers, p => p.Name == "spec-writer");
        Assert.Equal("profile", fromProfile.Source);
        Assert.Null(fromProfile.Copy);
        Assert.Null(fromProfile.Model);

        var mainCopy = Assert.Single(performers.Copies);
        Assert.Equal(copy, mainCopy.Path);
        Assert.Equal("app", mainCopy.Name);
        Assert.Equal("dev", mainCopy.Branch);
        Assert.True(mainCopy.Main);
    }

    [Fact]
    public async Task Performers_EmptyWhenNothingIsSetUp()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));

        var performers = Assert.Single(await Get(Path.Combine(_root, "profile"), CreateBase("app-knowledge", copy)));

        Assert.Empty(performers.Performers);
        Assert.Null(performers.Error);
    }

    [Fact]
    public async Task Performers_WritesFileIntoChosenCopyAndCommitsIt()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, copy, "reviewer", "Читает дифф ветки задачи.", "opus", "Read, Glob, Grep", "Ты читаешь дифф."));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var file = Path.Combine(copy, ".claude", "agents", "reviewer.md");
        Assert.Equal(file, (await response.Content.ReadFromJsonAsync<PerformerSavedResponse>())!.Path);

        var text = File.ReadAllText(file).ReplaceLineEndings("\n");
        Assert.Equal("""
            ---
            name: reviewer
            description: Читает дифф ветки задачи.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф.

            """.ReplaceLineEndings("\n"), text);

        Assert.Empty(Status(copy));
    }

    [Fact]
    public async Task Performers_SecondSaveRewritesTheSameFile()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        await Save(basePath, new SavePerformerRequest(basePath, copy, "reviewer", "Первое", null, null, "Тело"));
        var second = await Save(basePath, new SavePerformerRequest(
            basePath, copy, "reviewer", "Второе", null, null, "Другое тело"));

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var text = File.ReadAllText(Path.Combine(copy, ".claude", "agents", "reviewer.md"));
        Assert.Contains("description: Второе", text);
        Assert.DoesNotContain("Первое", text);
        Assert.Single(Directory.GetFiles(Path.Combine(copy, ".claude", "agents")));
    }

    [Fact]
    public async Task Performers_CommitSaysWhetherPerformerWasAddedOrChanged()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        await Save(basePath, new SavePerformerRequest(basePath, copy, "reviewer", "Первое", null, null, "Тело"));
        Assert.Equal("Исполнитель заведён из панели", Subject(copy));

        await Save(basePath, new SavePerformerRequest(basePath, copy, "reviewer", "Второе", null, null, "Другое тело"));
        // По истории копии видно, что произошло: правка заведённого — не заведение — решение оператора на B-69.
        Assert.Equal("Исполнитель изменён из панели", Subject(copy));
    }

    [Fact]
    public async Task Performers_CommitTakesOnlyThePerformerFile()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        // Рядом идёт чужая работа: её правка не должна уехать в коммит панели.
        File.WriteAllText(Path.Combine(copy, "readme.md"), "чужая незакоммиченная правка\n");
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, copy, "reviewer", "Читает дифф.", null, null, "Тело"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal([".claude/agents/reviewer.md"], CommittedFiles(copy));
        Assert.Equal(["?? readme.md"], Status(copy));
    }

    [Fact]
    public async Task Performers_RefusesNameThatIsNotASubagentName()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, copy, "Ревью Диффа", "Описание", null, null, "Тело"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-name", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(Directory.Exists(Path.Combine(copy, ".claude")));
    }

    [Fact]
    public async Task Performers_RefusesCopyThatIsNotOfTheBase()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var stranger = TestGit.Repository(Path.Combine(_root, "stranger"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, stranger, "reviewer", "Описание", null, null, "Тело"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.False(Directory.Exists(Path.Combine(stranger, ".claude")));
    }

    [Fact]
    public async Task Performers_RefusedCommitIsReportedAndLeavesNothingStaged()
    {
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        // Хук проекта отказывает — оператор должен увидеть его вывод дословно.
        var hooks = Path.Combine(copy, ".git", "hooks");
        Directory.CreateDirectory(hooks);
        File.WriteAllText(Path.Combine(hooks, "pre-commit"), "#!/bin/sh\necho 'сверка не прошла'\nexit 1\n".ReplaceLineEndings("\n"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(basePath, new SavePerformerRequest(
            basePath, copy, "reviewer", "Описание", null, null, "Тело"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var rejected = await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>();
        Assert.Equal("not-committed", rejected!.Problem);
        Assert.Contains("сверка не прошла", rejected.Detail);
        // Файл остался на диске, но не в индексе: иначе его унесла бы в свой коммит чужая сессия.
        Assert.Equal(["?? .claude/"], Status(copy));
    }

    private static void Performer(string root, string name, string text)
    {
        var directory = Path.Combine(root, ".claude", "agents");
        if (root.EndsWith("profile", StringComparison.Ordinal))
            directory = Path.Combine(root, "agents");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, name + ".md"), text.ReplaceLineEndings("\n"));
    }

    private string CreateBase(string name, params string[] copies)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(Path.Combine(basePath, "work"));
        var json = System.Text.Json.JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies });
        File.WriteAllText(Path.Combine(basePath, "agents-kit.json"), json);
        return basePath;
    }

    private static string Subject(string copy) => Run(copy, "log", "-1", "--format=%s").Trim();

    private static string[] Status(string copy) =>
        Run(copy, "status", "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray();

    private static string[] CommittedFiles(string copy) =>
        Run(copy, "show", "--name-only", "--format=").Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim()).ToArray();

    private static string Run(string workingDirectory, params string[] args)
    {
        // Сообщения коммитов панели по-русски: без UTF-8 вывод git читается кодировкой консоли и не сходится.
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

    private WebApplicationFactory<Program> Factory(string claudeDir, params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([
                    new("BasesFile", TestBases.File(_root, bases)),
                    new("ClaudeDir", claudeDir),
                ]);
            }));

    private async Task<List<BasePerformers>> Get(string claudeDir, params string[] bases)
    {
        await using var factory = Factory(claudeDir, bases);
        var response = await factory.CreateClient().GetAsync("/api/performers");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<List<BasePerformers>>() ?? [];
    }

    private async Task<HttpResponseMessage> Save(string basePath, SavePerformerRequest request)
    {
        await using var factory = Factory(Path.Combine(_root, "profile"), basePath);
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
    }
}
