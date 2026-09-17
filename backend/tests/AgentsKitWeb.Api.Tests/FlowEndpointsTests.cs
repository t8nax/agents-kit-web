using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
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
    private const string Flow = """
        # App — флоу

        <!-- Как на этом проекте ведут задачу. -->

        ## 1. Критерий

        исполнитель: оркестратор
        выход: критерий закрытия в памяти

        1.1. Написать критерий до первой строчки кода.

        ## 2. Приёмка

        исполнитель: оператор
        выход: ответ оператора «принято»

        2.1. Поднять dev-панель.
           2.1.1. Назвать адрес оператору.

        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-flow-").FullName;
    private readonly string _base;
    private readonly string _flowPath;
    private readonly FakeEditorWindows _windows = new();

    public FlowEndpointsTests()
    {
        _base = TestGit.Repository(Path.Combine(_root, "app-knowledge"));
        TestGit.Run(_base, "config", "user.name", "t");
        TestGit.Run(_base, "config", "user.email", "t@t");
        TestGit.Run(_base, "config", "core.autocrlf", "false");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# App — продукт\n");
        _flowPath = Path.Combine(_base, "flow.md");
        File.WriteAllText(_flowPath, Flow.ReplaceLineEndings("\n"));
        TestGit.Run(_base, "add", "flow.md", "product.md");
        TestGit.Run(_base, "commit", "-m", "flow");
    }

    [Fact]
    public async Task Flow_ReturnsStepsTasksInWorkAndVersionPerBase()
    {
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(Path.Combine(_base, "work", "a.md"), "# Задача\nрабочая копия: D:\\a\n");
        File.WriteAllText(Path.Combine(_base, "work", "b.md"), "# Задача\nрабочая копия: D:\\b\n");
        var withoutFile = Path.Combine(_root, "empty-knowledge");
        Directory.CreateDirectory(withoutFile);
        var missing = Path.Combine(_root, "gone-knowledge");

        var flows = await GetFlows(Client(_base, withoutFile, missing));

        var flow = Assert.Single(flows, f => f.Base == _base);
        Assert.Equal("App", flow.Project);
        Assert.Null(flow.Error);
        Assert.Equal(2, flow.ActiveTasks);
        Assert.NotNull(flow.Version);
        Assert.Equal(["Критерий", "Приёмка"], flow.Steps.Select(s => s.Title));
        Assert.Equal("оператор", flow.Steps[1].Executor);
        Assert.Equal("В базе нет flow.md", Assert.Single(flows, f => f.Base == withoutFile).Error);
        Assert.Equal("База не найдена на диске", Assert.Single(flows, f => f.Base == missing).Error);
    }

    [Fact]
    public async Task Save_RewritesFlowAndCommitsOnlyFlowFile()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        // Соседняя сессия оставила в индексе базы свою правку: коммит панели её не берёт.
        File.WriteAllText(Path.Combine(_base, "backlog.md"), "# бэклог\n");
        TestGit.Run(_base, "add", "backlog.md");

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, [
            flow.Steps[1],
            flow.Steps[0] with { Skip = "правка только в текстах" },
            new FlowStep("Мерж", "оркестратор", "sha в dev", null, "9.1. Смержить в dev."),
        ]));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""
            # App — флоу

            <!-- Как на этом проекте ведут задачу. -->

            ## 1. Приёмка

            исполнитель: оператор
            выход: ответ оператора «принято»

            1.1. Поднять dev-панель.
               1.1.1. Назвать адрес оператору.

            ## 2. Критерий

            исполнитель: оркестратор
            выход: критерий закрытия в памяти
            пропуск: правка только в текстах

            2.1. Написать критерий до первой строчки кода.

            ## 3. Мерж

            исполнитель: оркестратор
            выход: sha в dev

            3.1. Смержить в dev.

            """.ReplaceLineEndings("\n"), File.ReadAllText(_flowPath));

        Assert.Equal("Флоу правлен из панели", Git("log", "-1", "--format=%s"));
        Assert.Equal("flow.md", Git("show", "--name-only", "--format=", "HEAD"));
        Assert.Equal("A  backlog.md", Git("status", "--porcelain"));

        var saved = await response.Content.ReadFromJsonAsync<FlowSavedResponse>();
        Assert.Equal(Assert.Single(await GetFlows(client)).Version, saved!.Version);
    }

    [Fact]
    public async Task Save_FileChangedSinceRead_IsRejectedAndFileUntouched()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        File.AppendAllText(_flowPath, "\n## 3. Мерж\n\nисполнитель: оркестратор\nвыход: sha\n");
        var before = File.ReadAllText(_flowPath);

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, [flow.Steps[0]]));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("changed", (await response.Content.ReadFromJsonAsync<FlowRejectedResponse>())!.Problem);
        Assert.Equal(before, File.ReadAllText(_flowPath));
    }

    [Fact]
    public async Task Save_StepBreakingKitForm_IsRejectedWithItsNumber()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, [
            flow.Steps[0],
            flow.Steps[1] with { Output = " " },
        ]));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new FlowRejectedResponse("invalid", 2, "empty-output"), await response.Content.ReadFromJsonAsync<FlowRejectedResponse>());
        Assert.Equal(Flow.ReplaceLineEndings("\n"), File.ReadAllText(_flowPath));
    }

    [Fact]
    public async Task Save_CommitRefusedByHook_RestoresFileAndReportsGitOutput()
    {
        File.WriteAllText(Path.Combine(_base, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'сверка: флоу не прошёл' >&2\nexit 1\n");
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, [flow.Steps[1], flow.Steps[0]]));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var rejected = await response.Content.ReadFromJsonAsync<FlowRejectedResponse>();
        Assert.Equal("not-committed", rejected!.Problem);
        Assert.Contains("сверка: флоу не прошёл", rejected.Detail);
        Assert.Equal(Flow.ReplaceLineEndings("\n"), File.ReadAllText(_flowPath));
        Assert.Equal("flow", Git("log", "-1", "--format=%s"));
        // Отказанная правка не осталась и в индексе: следующий чужой коммит её не заберёт.
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Save_SameSteps_WritesNothing()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(flow.Base, flow.Version!, flow.Steps));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("flow", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_BaseNotInList_IsNotFound()
    {
        var client = Client(Path.Combine(_root, "other-knowledge"));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(_base, "x", []));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(Flow.ReplaceLineEndings("\n"), File.ReadAllText(_flowPath));
    }

    [Fact]
    public async Task Save_KeepsChosenIconsBesideBasesFileAndGivesThemBack()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));

        var response = await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            flow.Base,
            flow.Version!,
            flow.Steps,
            new Dictionary<string, string> { ["Критерий"] = "target", ["Приёмка"] = "check" }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(File.Exists(Path.Combine(_root, "panel", "flow-icons.json")));
        var saved = Assert.Single(await GetFlows(Client(_base)));
        Assert.Equal("target", saved.Icons["Критерий"]);
        Assert.Equal("check", saved.Icons["Приёмка"]);
    }

    [Fact]
    public async Task Save_UnknownIconAndIconOfGoneStep_AreNotKept()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            flow.Base,
            flow.Version!,
            flow.Steps,
            new Dictionary<string, string> { ["Критерий"] = "target", ["Приёмка"] = "check" }));

        var written = Assert.Single(await GetFlows(client));
        await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            written.Base,
            written.Version!,
            [written.Steps[0]],
            new Dictionary<string, string> { ["Критерий"] = "лунная-дорожка" }));

        var saved = Assert.Single(await GetFlows(Client(_base)));
        Assert.Empty(saved.Icons);
    }

    [Fact]
    public async Task Save_SameStepsButOtherIcon_KeepsNewIcon()
    {
        var client = Client(_base);
        var flow = Assert.Single(await GetFlows(client));
        await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            flow.Base,
            flow.Version!,
            flow.Steps,
            new Dictionary<string, string> { ["Критерий"] = "target" }));

        await client.PostAsJsonAsync("/api/flow", new SaveFlowRequest(
            flow.Base,
            flow.Version!,
            flow.Steps,
            new Dictionary<string, string> { ["Критерий"] = "code" }));

        var saved = Assert.Single(await GetFlows(Client(_base)));
        Assert.Equal("code", saved.Icons["Критерий"]);
        Assert.Equal("flow", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Open_OpensFlowFileInWindowOnBase()
    {
        var response = await Client(_base).PostAsJsonAsync("/api/flow/open", new OpenFlowRequest(_base));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal((_base, _flowPath), Assert.Single(_windows.OpenedFiles));
    }

    [Fact]
    public async Task Open_EditorFailed_IsBadGateway()
    {
        _windows.Result = false;

        var response = await Client(_base).PostAsJsonAsync("/api/flow/open", new OpenFlowRequest(_base));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

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

    private string Git(params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = _base,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
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
