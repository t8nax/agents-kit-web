using System.Net;
using System.Net.Http.Json;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class BacklogEndpointTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-tests-").FullName;

    [Fact]
    public async Task Backlog_ReturnsEntriesPerBaseWithProjectName()
    {
        var first = CreateBase("app-knowledge", """
            # Проект — бэклог

            следующий номер: B-3

            ## B-1 Панель показывает проблемы баз знаний

            Сейчас панель не говорит, что с базой что-то не так.

            ### Агенту
            - где: design/sketch.html

            ## B-2 Светлая тема

            Панель сейчас только тёмная.
            """);
        File.WriteAllText(Path.Combine(first, "product.md"), "# Order Service — продукт\n");
        var second = CreateBase("nota-knowledge", "## B-4 Экспорт заметок\n\nЗабрать заметки нечем.\n");

        var backlogs = await GetBacklogs(first, second);

        Assert.Equal(2, backlogs.Count);

        var firstBacklog = Assert.Single(backlogs, b => b.Base == first);
        Assert.Equal("Order Service", firstBacklog.Project);
        Assert.Null(firstBacklog.Error);
        Assert.Equal(["B-1", "B-2"], firstBacklog.Entries.Select(e => e.Number));
        Assert.Equal("Светлая тема", firstBacklog.Entries[1].Title);
        Assert.Equal("Сейчас панель не говорит, что с базой что-то не так.", firstBacklog.Entries[0].Text);

        var secondBacklog = Assert.Single(backlogs, b => b.Base == second);
        Assert.Equal("nota-knowledge", secondBacklog.Project);
        Assert.Equal("Экспорт заметок", Assert.Single(secondBacklog.Entries).Title);
    }

    [Fact]
    public async Task Backlog_CarriesTheProjectsLettersAndForeignNumbers()
    {
        var basePath = CreateBase("orders-knowledge", "следующий номер: ORD-18\n\n## ORD-15 Повторная оплата\n\n## B-7 Чужими буквами\n");

        var backlog = Assert.Single(await GetBacklogs(basePath));

        Assert.Equal("ORD", backlog.Letters);
        Assert.Equal(["ORD-15", "B-7"], backlog.Entries.Select(e => e.Number));
    }

    [Fact]
    public async Task Backlog_RereadsFileOnEachRequest()
    {
        var basePath = CreateBase("app-knowledge", "## B-1 Первая\n\nТекст.\n");
        await using var factory = Factory(basePath);
        var client = factory.CreateClient();

        var before = await Get(client);
        File.WriteAllText(Path.Combine(basePath, "backlog.md"), "## B-1 Первая\n\nТекст.\n\n## B-2 Вторая\n\nДописана соседней сессией.\n");
        var after = await Get(client);

        Assert.Equal(["B-1"], Assert.Single(before).Entries.Select(e => e.Number));
        Assert.Equal(["B-1", "B-2"], Assert.Single(after).Entries.Select(e => e.Number));
    }

    [Fact]
    public async Task Backlog_EmptyBacklogHasNoEntriesAndNoError()
    {
        var basePath = CreateBase("app-knowledge", "# Проект — бэклог\n\nследующий номер: B-1\n");

        var backlog = Assert.Single(await GetBacklogs(basePath));

        Assert.Empty(backlog.Entries);
        Assert.Null(backlog.Error);
    }

    [Fact]
    public async Task Backlog_MissingFileAndMissingBaseAreReportedSeparately()
    {
        var withoutFile = Path.Combine(_root, "no-file-knowledge");
        Directory.CreateDirectory(withoutFile);
        var missingBase = Path.Combine(_root, "gone-knowledge");

        var backlogs = await GetBacklogs(withoutFile, missingBase);

        Assert.Equal("В базе нет backlog.md", Assert.Single(backlogs, b => b.Base == withoutFile).Error);
        Assert.Equal("База не найдена на диске", Assert.Single(backlogs, b => b.Base == missingBase).Error);
    }

    [Fact]
    public async Task Backlog_NoBasesConfigured_ReturnsEmptyList()
    {
        Assert.Empty(await GetBacklogs());
    }

    [Fact]
    public async Task Backlog_ReturnsDeclaredFieldsOfEntries()
    {
        var basePath = CreateBase("app-knowledge", """
            # Проект — бэклог

            следующий номер: B-3
            поля: приоритет, тип

            ## B-1 Панель показывает проблемы баз знаний

            приоритет: блокер
            тип: баг

            Сейчас панель не говорит, что с базой что-то не так.

            ## B-2 Светлая тема

            тип: фича

            Панель сейчас только тёмная.
            """);

        var entries = Assert.Single(await GetBacklogs(basePath)).Entries;

        Assert.Equal("блокер", entries[0].Priority);
        Assert.Equal("баг", entries[0].Type);
        Assert.Equal("Сейчас панель не говорит, что с базой что-то не так.", entries[0].Text);
        Assert.Null(entries[1].Priority);
        Assert.Equal("фича", entries[1].Type);
    }

    [Fact]
    public async Task Backlog_WithoutDeclarationHasNoFields()
    {
        var basePath = CreateBase("app-knowledge", "## B-1 Первая\n\nприоритет: блокер\n\nТекст.\n");

        var entry = Assert.Single(Assert.Single(await GetBacklogs(basePath)).Entries);

        Assert.Null(entry.Priority);
        Assert.Null(entry.Type);
    }

    private string CreateBase(string name, string backlog)
    {
        var basePath = Path.Combine(_root, name);
        Directory.CreateDirectory(basePath);
        File.WriteAllText(Path.Combine(basePath, "backlog.md"), backlog.ReplaceLineEndings("\n"));
        return basePath;
    }

    private WebApplicationFactory<Program> Factory(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            }));

    private async Task<List<BaseBacklog>> GetBacklogs(params string[] bases)
    {
        await using var factory = Factory(bases);
        return await Get(factory.CreateClient());
    }

    private static async Task<List<BaseBacklog>> Get(HttpClient client)
    {
        var response = await client.GetAsync("/api/backlog");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<List<BaseBacklog>>() ?? [];
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
