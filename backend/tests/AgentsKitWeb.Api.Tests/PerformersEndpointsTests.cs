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
    public async Task Performers_ListsProfilePerformersOfTheProjectWithTheirFields()
    {
        var claudeDir = Path.Combine(_root, "profile");
        Performer(claudeDir, "order-service-reviewer", """
            ---
            name: order-service-reviewer
            description: Читает дифф ветки задачи и возвращает вердикт.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф ветки целиком.
            """);

        var basePath = CreateBase("app-knowledge");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");

        var performers = Assert.Single(await Get(claudeDir, basePath));

        Assert.Equal("Order Service", performers.Project);
        Assert.Equal("order-service", performers.Prefix);
        Assert.Equal(Path.Combine(claudeDir, "agents"), performers.Directory);
        Assert.Null(performers.Error);

        // Имя показывается без приставки: её ставит панель, и оператору она не видна.
        var reviewer = Assert.Single(performers.Performers);
        Assert.Equal("reviewer", reviewer.Name);
        Assert.Equal("Читает дифф ветки задачи и возвращает вердикт.", reviewer.Description);
        Assert.Equal("opus", reviewer.Model);
        Assert.Equal("Read, Glob, Grep", reviewer.Tools);
        Assert.Equal("Ты читаешь дифф ветки целиком.", reviewer.Prompt);
        Assert.Equal(Path.Combine(claudeDir, "agents", "order-service-reviewer.md"), reviewer.Path);
    }

    [Fact]
    public async Task Performers_SkipsPerformersOfOtherProjectsAndOfNobody()
    {
        var claudeDir = Path.Combine(_root, "profile");
        Performer(claudeDir, "order-service-reviewer", "---\nname: order-service-reviewer\n---\n\nТело.\n");
        Performer(claudeDir, "nota-reviewer", "---\nname: nota-reviewer\n---\n\nТело.\n");
        // Заведён оператором мимо панели: приставки проекта нет, и разделу он не принадлежит.
        Performer(claudeDir, "statusline-setup", "---\nname: statusline-setup\n---\n\nТело.\n");

        var basePath = CreateBase("app-knowledge");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");

        var performers = Assert.Single(await Get(claudeDir, basePath));

        Assert.Equal(["reviewer"], performers.Performers.Select(p => p.Name));
    }

    [Fact]
    public async Task Performers_EmptyWhenNothingIsSetUp()
    {
        var performers = Assert.Single(await Get(Path.Combine(_root, "profile"), CreateBase("app-knowledge")));

        Assert.Empty(performers.Performers);
        Assert.Null(performers.Error);
    }

    [Fact]
    public async Task Performers_WritesFileIntoProfileWithTheProjectPrefix()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("app-knowledge");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Order Service — продукт\n");

        var response = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "reviewer", "Читает дифф ветки задачи.", "opus", "Read, Glob, Grep", "Ты читаешь дифф.", null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var file = Path.Combine(claudeDir, "agents", "order-service-reviewer.md");
        Assert.Equal(file, (await response.Content.ReadFromJsonAsync<PerformerSavedResponse>())!.Path);

        // В файл идёт полное имя: этим именем зовёт исполнителя шаг флоу и ищет его Claude Code.
        Assert.Equal("""
            ---
            name: order-service-reviewer
            description: Читает дифф ветки задачи.
            tools: Read, Glob, Grep
            model: opus
            ---

            Ты читаешь дифф.

            """.ReplaceLineEndings("\n"), File.ReadAllText(file).ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task Performers_WritesNothingIntoWorkingCopies()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var copy = TestGit.Repository(Path.Combine(_root, "app"));
        var basePath = CreateBase("app-knowledge", copy);

        var response = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        // Копия — чужая работа и чужая ветка: панель в неё не пишет и в ней не коммитит.
        Assert.False(Directory.Exists(Path.Combine(copy, ".claude")));
        Assert.Empty(Status(copy));
    }

    [Fact]
    public async Task Performers_EditingRewritesTheSameFile()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("app-knowledge");

        await Save(claudeDir, basePath, new SavePerformerRequest(basePath, "reviewer", "Первое", null, null, "Тело", null));
        var second = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "reviewer", "Второе", null, null, "Другое тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var text = File.ReadAllText(Path.Combine(claudeDir, "agents", "app-reviewer.md"));
        Assert.Contains("description: Второе", text);
        Assert.DoesNotContain("Первое", text);
        Assert.Single(Directory.GetFiles(Path.Combine(claudeDir, "agents")));
    }

    [Fact]
    public async Task Performers_RefusesNameAlreadyTakenInTheProject()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("app-knowledge");
        await Save(claudeDir, basePath, new SavePerformerRequest(basePath, "reviewer", "Первое", null, null, "Тело", null));

        var again = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "reviewer", "Другой исполнитель", null, null, "Другое тело", null));

        // Набор один на машину: молча переписать заведённого — потерять его.
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("name-taken", (await again.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.Contains("Первое", File.ReadAllText(Path.Combine(claudeDir, "agents", "app-reviewer.md")));
    }

    [Fact]
    public async Task Performers_RenamingLeavesOnlyTheNewFile()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("app-knowledge");
        await Save(claudeDir, basePath, new SavePerformerRequest(basePath, "reviewer", "Описание", null, null, "Тело", null));

        var renamed = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "code-reviewer", "Описание", null, null, "Тело", "reviewer"));

        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal(["app-code-reviewer.md"], Directory.GetFiles(Path.Combine(claudeDir, "agents")).Select(Path.GetFileName));
    }

    [Fact]
    public async Task Performers_RefusesNameThatIsNotASubagentName()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("app-knowledge");

        var response = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "Ревью Диффа", "Описание", null, null, "Тело", null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid-name", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
        Assert.False(Directory.Exists(Path.Combine(claudeDir, "agents")));
    }

    [Fact]
    public async Task Performers_ProjectWithoutLatinNameKeepsNoPerformers()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("база");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Заказы — продукт\n");

        var performers = Assert.Single(await Get(claudeDir, basePath));
        Assert.Equal("", performers.Prefix);
        Assert.NotNull(performers.Error);

        // Без приставки исполнитель слился бы с чужими: панель такому проекту его не заводит.
        var response = await Save(claudeDir, basePath, new SavePerformerRequest(
            basePath, "reviewer", "Описание", null, null, "Тело", null));
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("no-prefix", (await response.Content.ReadFromJsonAsync<PerformerRejectedResponse>())!.Problem);
    }

    [Fact]
    public async Task Performers_PrefixFallsBackToBaseFolderWithoutItsKnowledgeTail()
    {
        var claudeDir = Path.Combine(_root, "profile");
        var basePath = CreateBase("order-service-knowledge");
        File.WriteAllText(Path.Combine(basePath, "product.md"), "# Заказы — продукт\n");

        var performers = Assert.Single(await Get(claudeDir, basePath));

        Assert.Equal("order-service", performers.Prefix);
    }

    private static void Performer(string profile, string name, string text)
    {
        var directory = Path.Combine(profile, "agents");
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

    private async Task<HttpResponseMessage> Save(string claudeDir, string basePath, SavePerformerRequest request)
    {
        await using var factory = Factory(claudeDir, basePath);
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
