using System.Net.Http.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Health;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace AgentsKitWeb.Api.Tests;

public sealed class HealthTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-health-").FullName;
    private readonly string _main;
    private readonly string _worktree;
    private readonly string _base;
    private readonly WebApplicationFactory<Program> _factory;

    public HealthTests()
    {
        _main = TestGit.Repository(Path.Combine(_root, "app"));
        _worktree = Path.Combine(_root, "app-wt");
        TestGit.Run(_main, "worktree", "add", "-b", "feat/wt", _worktree);

        _base = Directory.CreateDirectory(Path.Combine(_root, "app-knowledge")).FullName;
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"),
            System.Text.Json.JsonSerializer.Serialize(new { workspaces = new[] { _main } }));
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");

        var file = TestBases.File(_root, _base);
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", file), new("HealthIntervalSeconds", "3600")]);
            }));
    }

    private HttpClient Client => _factory.CreateClient();

    [Fact]
    public async Task Health_KitNotSet_BasesAreUnchecked()
    {
        var snapshot = await WaitFor(s => !s.Pending);

        Assert.Equal(KitStatus.NotSet, snapshot.Kit);
        var baseHealth = Assert.Single(snapshot.Bases);
        Assert.Equal(BaseHealthStatus.Unchecked, baseHealth.Status);
        Assert.Equal("Order Service", baseHealth.Project);
    }

    [Fact]
    public async Task Health_KitSet_ReturnsKitFindingsOncePerBaseAndLinkProblemsPerCopy()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"),
            baseCheck: """
                function Get-KitBaseFindings([string]$Base, [string]$Worktree) {
                    [pscustomobject]@{ severity = 'FAIL'; file = 'product.md'; message = '53 строк при потолке 50'; kind = '' }
                    [pscustomobject]@{ severity = 'WARN'; file = "work\$(Split-Path $Worktree -Leaf).md"; message = 'ссылка «выше»'; kind = '' }
                }
                """,
            linkState: $$"""
                function Get-KitLinkState([string]$Dir) {
                    if ($Dir -like '*-wt') { return [pscustomobject]@{ status = 'Unlisted'; base = '{{_base}}' } }
                    [pscustomobject]@{ status = 'Linked'; base = '{{_base}}' }
                }
                """);
        await WaitFor(s => !s.Pending);

        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        var snapshot = await WaitFor(s => s.Kit == KitStatus.Ok && s.Bases.All(b => b.Status != BaseHealthStatus.Unchecked));

        var baseHealth = Assert.Single(snapshot.Bases);
        Assert.Equal(BaseHealthStatus.Checked, baseHealth.Status);
        Assert.Equal(
            [
                new HealthProblem("error", "product.md", "53 строк при потолке 50"),
                new HealthProblem("warning", "work\\app.md", "ссылка «выше»"),
                new HealthProblem("warning", "work\\app-wt.md", "ссылка «выше»"),
            ],
            baseHealth.Problems);
        Assert.Empty(Assert.Single(baseHealth.Copies, c => c.Path == _main).Problems);
        Assert.Equal(
            [new HealthProblem("error", null, "база не числит эту копию своей")],
            Assert.Single(baseHealth.Copies, c => c.Path == _worktree).Problems);
    }

    [Fact]
    public async Task Health_KitScriptFails_BaseIsFailedWithReason()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"),
            baseCheck: "function Get-KitBaseFindings { throw 'сверка сломалась' }");
        await WaitFor(s => !s.Pending);

        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        var snapshot = await WaitFor(s => s.Kit == KitStatus.Ok && s.Bases.All(b => b.Status != BaseHealthStatus.Unchecked));

        var baseHealth = Assert.Single(snapshot.Bases);
        Assert.Equal(BaseHealthStatus.Failed, baseHealth.Status);
        Assert.Contains("сверка сломалась", baseHealth.Error);
        Assert.Empty(baseHealth.Problems);
    }

    [Fact]
    public async Task Health_KitRemovedAfterSet_KitIsNotFound()
    {
        var kit = TestKit.Create(Path.Combine(_root, "agents-kit"));
        await WaitFor(s => !s.Pending);
        await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(kit));
        await WaitFor(s => s.Kit == KitStatus.Ok);

        Directory.Delete(kit, recursive: true);
        // Смену на диске монитор видит на следующем круге; здесь его будит повторное сохранение списка.
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(_base));
        var extra = Directory.CreateDirectory(Path.Combine(_root, "other-knowledge")).FullName;
        File.WriteAllText(Path.Combine(extra, "agents-kit.json"), """{ "workspaces": [] }""");
        await Client.PostAsJsonAsync("/api/bases", new AddBaseRequest(extra));

        var snapshot = await WaitFor(s => s.Kit == KitStatus.NotFound);
        Assert.All(snapshot.Bases, b => Assert.Equal(BaseHealthStatus.Unchecked, b.Status));
    }

    [Theory]
    [InlineData("Linked", "SAME", null)]
    [InlineData("Linked", "D:\\other-knowledge", "копия связана с другой базой «D:\\other-knowledge»")]
    [InlineData("NotGit", null, "каталог копии не в git-репозитории")]
    [InlineData("NoPointer", null, "копия не связана с базой: указателя на базу нет")]
    [InlineData("BaseMissing", "D:\\gone", "копия указывает на базу «D:\\gone», а её нет на диске")]
    [InlineData("NotBase", "D:\\plain", "копия указывает на «D:\\plain», а это не база кита")]
    [InlineData("Unlisted", "SAME", "база не числит эту копию своей")]
    public void LinkProblems_NamesBrokenLink(string status, string? linkBase, string? message)
    {
        const string basePath = "D:\\app-knowledge";
        var problems = HealthMonitor.LinkProblems(basePath,
            new KitLinkState("D:\\app", status, linkBase == "SAME" ? basePath + "\\" : linkBase));

        if (message is null)
            Assert.Empty(problems);
        else
            Assert.Equal([new HealthProblem("error", null, message)], problems);
    }

    private async Task<HealthSnapshot> WaitFor(Func<HealthSnapshot, bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        HealthSnapshot? last = null;
        while (DateTime.UtcNow < deadline)
        {
            last = await Client.GetFromJsonAsync<HealthSnapshot>("/api/health");
            if (last is not null && condition(last))
                return last;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Снимок не дождался условия; последний: {System.Text.Json.JsonSerializer.Serialize(last)}");
    }

    public void Dispose()
    {
        _factory.Dispose();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (UnauthorizedAccessException)
        {
            // git оставляет файлы только для чтения в .git — их хвост во временном каталоге не мешает прогону.
        }
    }
}
