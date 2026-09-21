using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowEndpointsTests : IDisposable
{
    private const string List = """
        # App — флоу

        <!-- Как на этом проекте ведут задачу. -->

        ## полный
        когда: новая возможность
        1. [Критерий](stages/criterion.md)
        2. [Приёмка](stages/acceptance.md)
           - возврат: замечания — стадия «Критерий»

        ## мелкий
        когда: правка в одном месте
        1. [Приёмка](stages/acceptance.md)

        """;

    private const string Criterion = """
        # Критерий

        исполнитель: оркестратор
        выход: критерий закрытия в памяти

        - Написать критерий до первой строчки кода.

        """;

    // Файл стадии правлен руками не в разметке панели: нетронутым панель его не переписывает.
    private const string Acceptance = """
        # Приёмка
        исполнитель: оператор
        выход: ответ оператора «принято»

        1. Поднять dev-панель.
           1.1. Назвать адрес оператору.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-flow-").FullName;
    private readonly string _base;
    private readonly string _listPath;
    private readonly FakeEditorWindows _windows = new();

    public FlowEndpointsTests()
    {
        _base = Knowledge("app-knowledge");
        Directory.CreateDirectory(Path.Combine(_base, "flow", "stages"));
        _listPath = Path.Combine(_base, "flow", "flow.md");
        File.WriteAllText(_listPath, List.ReplaceLineEndings("\n"));
        File.WriteAllText(Stage("criterion"), Criterion.ReplaceLineEndings("\n"));
        File.WriteAllText(Stage("acceptance"), Acceptance.ReplaceLineEndings("\n"));
        TestGit.Run(_base, "add", "flow");
        TestGit.Run(_base, "commit", "-m", "flow");
    }

    [Fact]
    public async Task Flow_ReturnsStagesFlowsTasksInWorkAndVersionPerBase()
    {
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(Path.Combine(_base, "work", "a.md"), "# Задача\nрабочая копия: D:\\a\n");
        File.WriteAllText(Path.Combine(_base, "work", "b.md"), "# Задача\nрабочая копия: D:\\b\n");
        var withoutFlow = Path.Combine(_root, "empty-knowledge");
        Directory.CreateDirectory(withoutFlow);
        var oldForm = Path.Combine(_root, "old-knowledge");
        Directory.CreateDirectory(oldForm);
        File.WriteAllText(Path.Combine(oldForm, "flow.md"), "## 1. Ветка\n\nисполнитель: оркестратор\nвыход: ветка\n");
        var missing = Path.Combine(_root, "gone-knowledge");

        var flows = await GetFlows(Client(_base, withoutFlow, oldForm, missing));

        var flow = Assert.Single(flows, f => f.Base == _base);
        Assert.Equal("App", flow.Project);
        Assert.Null(flow.Error);
        Assert.Equal(2, flow.ActiveTasks);
        Assert.NotNull(flow.Version);
        Assert.Equal(["Приёмка", "Критерий"], flow.Stages.Select(s => s.Title));
        Assert.Equal("acceptance", flow.Stages[0].Slug);
        Assert.Equal(["полный", "мелкий"], flow.Flows.Select(f => f.Name));
        Assert.Equal(["Критерий", "Приёмка"], flow.Flows[0].Entries.Select(e => e.Stage));
        Assert.Equal(new StageReturn("замечания", "Критерий"), Assert.Single(flow.Flows[0].Entries[1].Returns!));
        // Базе без флоу новой формы — и без флоу вовсе, и со флоу старой формы — показывать нечего, но это не ошибка.
        foreach (var empty in new[] { withoutFlow, oldForm })
        {
            var none = Assert.Single(flows, f => f.Base == empty);
            Assert.Null(none.Error);
            Assert.Empty(none.Flows);
            Assert.Empty(none.Stages);
            Assert.NotNull(none.Version);
        }
        Assert.Equal("База не найдена на диске", Assert.Single(flows, f => f.Base == missing).Error);
    }

    [Fact]
    public async Task Save_ChangedStage_RewritesOnlyItsFileOnceForAllFlowsAndCommitsIt()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        // Соседняя сессия оставила в индексе базы свою правку: коммит панели её не берёт.
        File.WriteAllText(Path.Combine(_base, "backlog.md"), "# бэклог\n");
        TestGit.Run(_base, "add", "backlog.md");

        var response = await Save(client, flow, flow.Stages.Select(s =>
            s.Title == "Критерий" ? s with { Skip = "правка только в текстах", Helpers = ["scout"] } : s).ToList());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""
            # Критерий

            исполнитель: оркестратор
            помощники: scout
            выход: критерий закрытия в памяти
            пропуск: правка только в текстах

            - Написать критерий до первой строчки кода.

            """.ReplaceLineEndings("\n"), File.ReadAllText(Stage("criterion")));
        Assert.Equal(Acceptance.ReplaceLineEndings("\n"), File.ReadAllText(Stage("acceptance")));
        Assert.Equal(List.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
        Assert.Equal("Флоу правлен из панели", Git("log", "-1", "--format=%s"));
        Assert.Equal("flow/stages/criterion.md", Git("show", "--name-only", "--format=", "HEAD"));
        Assert.Equal("A  backlog.md", Git("status", "--porcelain"));

        var saved = await response.Content.ReadFromJsonAsync<FlowSavedResponse>();
        Assert.Equal(Assert.Single(await GetFlows(client)).Version, saved!.Version);
    }

    [Fact]
    public async Task Save_NewStageRenamedStageAndReorderedFlow_GoInOneCommit()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        var stages = flow.Stages.Select(s => s.Title == "Приёмка" ? s with { Title = "Сдача" } : s).ToList();
        stages.Add(new FlowStage("Фиксация знания", "оркестратор", "sha коммита базы", null, "- Записать в базу."));

        var response = await Save(client, flow, stages, [
            new NamedFlow("полный", "новая возможность", [
                new FlowEntry("Критерий"),
                new FlowEntry("Сдача", [new StageReturn("замечания", "Критерий")]),
                new FlowEntry("Фиксация знания"),
            ]),
            new NamedFlow("мелкий", "правка в одном месте", [new FlowEntry("Фиксация знания"), new FlowEntry("Сдача")]),
        ]);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""
            # App — флоу

            <!-- Как на этом проекте ведут задачу. -->

            ## полный
            когда: новая возможность
            1. [Критерий](stages/criterion.md)
            2. [Сдача](stages/acceptance.md)
               - возврат: замечания — стадия «Критерий»
            3. [Фиксация знания](stages/fiksatsiya-znaniya.md)

            ## мелкий
            когда: правка в одном месте
            1. [Фиксация знания](stages/fiksatsiya-znaniya.md)
            2. [Сдача](stages/acceptance.md)

            """.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
        Assert.Equal(
            "# Фиксация знания\n\nисполнитель: оркестратор\nвыход: sha коммита базы\n\n- Записать в базу.\n",
            File.ReadAllText(Stage("fiksatsiya-znaniya")));
        Assert.StartsWith("# Сдача\n", File.ReadAllText(Stage("acceptance")));
        Assert.Equal(
            ["flow/flow.md", "flow/stages/acceptance.md", "flow/stages/fiksatsiya-znaniya.md"],
            Git("show", "--name-only", "--format=", "HEAD").Split('\n').Order());
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Save_StageLeftOutOfList_IsDeletedFromBase()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await Save(client, flow, [flow.Stages[0]], [
            new NamedFlow("полный", "новая возможность", [new FlowEntry("Приёмка")]),
            flow.Flows[1],
        ]);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(File.Exists(Stage("criterion")));
        Assert.Contains("flow/stages/criterion.md", Git("show", "--name-only", "--format=", "HEAD"));
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Save_ChangedStageKeepsItsLineEndingsAndBom()
    {
        byte[] bom = [0xEF, 0xBB, 0xBF];
        File.WriteAllBytes(Stage("criterion"), [.. bom, .. Encoding.UTF8.GetBytes(Criterion.ReplaceLineEndings("\r\n"))]);
        TestGit.Run(_base, "commit", "-am", "crlf");
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        await Save(client, flow, flow.Stages.Select(s => s.Title == "Критерий" ? s with { Output = "критерий" } : s).ToList());

        var bytes = File.ReadAllBytes(Stage("criterion"));
        Assert.True(bytes.AsSpan().StartsWith(bom));
        Assert.Contains("выход: критерий\r\n", Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public async Task Save_AnyFlowFileChangedSinceRead_IsRejectedAndFilesUntouched()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        File.AppendAllText(Stage("acceptance"), "\nЕщё абзац.\n");
        var before = File.ReadAllText(Stage("acceptance"));

        var response = await Save(client, flow, [flow.Stages[1]], [new NamedFlow("полный", null, [new FlowEntry("Критерий")])]);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("changed", (await response.Content.ReadFromJsonAsync<FlowRejectedResponse>())!.Problem);
        Assert.Equal(before, File.ReadAllText(Stage("acceptance")));
        Assert.Equal(List.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
    }

    [Fact]
    public async Task Save_FlowBreakingKitForm_IsRejectedWithWhere()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await Save(client, flow, flow.Stages, [
            flow.Flows[0],
            flow.Flows[1] with { Entries = [new FlowEntry("Приёмка", [new StageReturn("замечания", "Критерий")])] },
        ]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            new FlowRejectedResponse("return-unknown-stage", "мелкий", "Приёмка"),
            await response.Content.ReadFromJsonAsync<FlowRejectedResponse>());
        Assert.Equal(List.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
    }

    [Fact]
    public async Task Flow_WithLinesNotInKitForm_NamesThemAndIsNotWritten()
    {
        File.AppendAllText(_listPath, "3. Мерж\n");
        File.WriteAllText(Stage("criterion"), Criterion.ReplaceLineEndings("\n").Replace("выход:", "возврат: замечания — стадия «Ревью»\nвыход:"));
        TestGit.Run(_base, "commit", "-am", "руками");
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        Assert.Equal(
            ["flow/flow.md, строка 14: «3. Мерж»", "flow/stages/criterion.md, строка 4: ключ вне перечня «возврат: замечания — стадия «Ревью»»"],
            flow.Unread);

        var response = await Save(client, flow, flow.Stages);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            new FlowRejectedResponse("unread", Detail: "flow/flow.md, строка 14: «3. Мерж»"),
            await response.Content.ReadFromJsonAsync<FlowRejectedResponse>());
        Assert.Equal("руками", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_CommitRefusedByHook_RestoresEveryFileAndIndex()
    {
        File.WriteAllText(Path.Combine(_base, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'сверка: флоу не прошёл' >&2\nexit 1\n");
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await Save(
            client,
            flow,
            [flow.Stages[0] with { Output = "принято" }, new FlowStage("Мерж", "оркестратор", "sha в dev", null, null)],
            [new NamedFlow("полный", "новая возможность", [new FlowEntry("Приёмка"), new FlowEntry("Мерж")]), flow.Flows[1]]);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var rejected = await response.Content.ReadFromJsonAsync<FlowRejectedResponse>();
        Assert.Equal("not-committed", rejected!.Problem);
        Assert.Contains("сверка: флоу не прошёл", rejected.Detail);
        Assert.Equal(List.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
        Assert.Equal(Acceptance.ReplaceLineEndings("\n"), File.ReadAllText(Stage("acceptance")));
        Assert.Equal(Criterion.ReplaceLineEndings("\n"), File.ReadAllText(Stage("criterion")));
        Assert.False(File.Exists(Stage("merzh")));
        Assert.Equal("flow", Git("log", "-1", "--format=%s"));
        // Отказанная правка не осталась и в индексе: следующий чужой коммит её не заберёт.
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Save_SameStagesAndFlows_WritesNothing()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await Save(client, flow, flow.Stages);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("flow", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_FirstFlowOfBaseWithoutFlow_CreatesFlowFolder()
    {
        var bare = Knowledge("bare-knowledge");
        var client = Client(bare);
        var flow = Assert.Single(await GetFlows(client));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            flow.Base,
            flow.Version!,
            [new FlowStage("Ветка", "оркестратор", "имя ветки", null, null)],
            [new NamedFlow("полный", null, [new FlowEntry("Ветка")])]));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            "# Bare — флоу\n\n## полный\n1. [Ветка](stages/vetka.md)\n",
            File.ReadAllText(Path.Combine(bare, "flow", "flow.md")));
        Assert.True(File.Exists(Path.Combine(bare, "flow", "stages", "vetka.md")));
        Assert.Equal("", GitIn(bare, "status", "--porcelain"));
    }

    [Fact]
    public async Task Save_BaseNotInList_IsNotFound()
    {
        var client = Client(Path.Combine(_root, "other-knowledge"));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(_base, "x", [], []));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(List.ReplaceLineEndings("\n"), File.ReadAllText(_listPath));
    }

    [Fact]
    public async Task Save_KeepsChosenIconsBesideBasesFileAndGivesThemBack()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await Save(client, flow, flow.Stages, icons: new Dictionary<string, string> { ["Критерий"] = "target", ["Приёмка"] = "check" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(File.Exists(Path.Combine(_root, "panel", "flow-icons.json")));
        var saved = Assert.Single(await GetFlows(Client(_base)));
        Assert.Equal("target", saved.Icons["Критерий"]);
        Assert.Equal("check", saved.Icons["Приёмка"]);
    }

    [Fact]
    public async Task Save_UnknownIcon_IsNotKept()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        await Save(client, flow, flow.Stages, icons: new Dictionary<string, string> { ["Критерий"] = "лунная-дорожка" });

        Assert.Empty(Assert.Single(await GetFlows(Client(_base))).Icons);
    }

    [Fact]
    public async Task Open_OpensFlowListInWindowOnBase()
    {
        var response = await Client(_base).PostAsJsonAsync("/api/flow/open", new OpenFlowRequest(_base));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal((_base, _listPath), Assert.Single(_windows.OpenedFiles));
    }

    [Fact]
    public async Task Open_EditorFailed_IsBadGateway()
    {
        _windows.Result = false;

        var response = await Client(_base).PostAsJsonAsync("/api/flow/open", new OpenFlowRequest(_base));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    /// <summary>База с git и product.md: проект называется по заголовку продукта.</summary>
    private string Knowledge(string name)
    {
        var path = TestGit.Repository(Path.Combine(_root, name));
        TestGit.Run(path, "config", "user.name", "t");
        TestGit.Run(path, "config", "user.email", "t@t");
        TestGit.Run(path, "config", "core.autocrlf", "false");
        var project = name == "app-knowledge" ? "App" : "Bare";
        File.WriteAllText(Path.Combine(path, "product.md"), $"# {project} — продукт\n");
        TestGit.Run(path, "add", "product.md");
        TestGit.Run(path, "commit", "-m", "init");
        return path;
    }

    private string Stage(string slug) => Path.Combine(_base, "flow", "stages", slug + ".md");

    private static Task<HttpResponseMessage> Save(
        HttpClient client,
        BaseFlow flow,
        IReadOnlyList<FlowStage> stages,
        IReadOnlyList<NamedFlow>? flows = null,
        IReadOnlyDictionary<string, string>? icons = null) =>
        client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, stages, flows ?? flow.Flows, icons));

    private HttpClient Client(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            });
            // VS Code в прогоне не открывается: проверяется, что панель попросила открыть.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IEditorWindows>();
                services.AddSingleton<IEditorWindows>(_windows);
            });
        }).CreateClient();

    private static async Task<List<BaseFlow>> GetFlows(HttpClient client) =>
        await client.GetFromJsonAsync<List<BaseFlow>>("/api/flow") ?? [];

    private string Git(params string[] args) => GitIn(_base, args);

    private static string GitIn(string repository, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = repository,
            RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return output.Trim();
    }

    private sealed class FakeEditorWindows : IEditorWindows
    {
        public List<(string Folder, string File)> OpenedFiles { get; } = [];

        public bool Result { get; set; } = true;

        public Task<bool> RaiseAsync(string copyPath, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task<bool> OpenAsync(string copyPath, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task<bool> OpenFileAsync(string folder, string file, CancellationToken cancellationToken)
        {
            OpenedFiles.Add((folder, file));
            return Task.FromResult(Result);
        }
    }

    public void Dispose()
    {
        try
        {
            // git помечает объекты только для чтения — иначе каталог не удалить.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
