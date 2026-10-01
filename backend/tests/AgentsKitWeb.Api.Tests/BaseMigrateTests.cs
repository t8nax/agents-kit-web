using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Перевод базы прежнего формата китом по кнопке «Перевести базу» в «Проблемах баз» (B-314).</summary>
public sealed class BaseMigrateTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-migrate-").FullName;
    private readonly string _copy;
    private readonly string _base;
    private readonly string _kit;
    private readonly FakeTerminals _terminals = new();
    private readonly WebApplicationFactory<Program> _factory;

    // Заглушка перевода пишет, с чем её позвали, и переводит базу, как кит: номер формата в agents-kit.json.
    private string Translates => $$"""
        param([string]$Path, [string]$Operator)
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'migrate.txt') -Value "$Path|$Operator" -Encoding utf8
        $marker = '{{Path.Combine(_base, BaseLayout.MarkerFile)}}'
        Set-Content -LiteralPath $marker -Value '{"kit":"agents-kit","version":{{BaseLayout.Format}}}' -Encoding utf8
        Write-Host 'База переведена на формат {{BaseLayout.Format}}.'
        """;

    private const string Pushes = """
        param([string]$Path, [string]$Repo, [string]$Action)
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'sync.txt') -Value "$Action $Repo $Path" -Encoding utf8
        Write-Host 'на remote базы отдано коммитов: 1'
        exit 0
        """;

    public BaseMigrateTests()
    {
        _copy = TestGit.Repository(Path.Combine(_root, "app"));
        _base = TestLayout.Base(Path.Combine(_root, "app-knowledge"), Path.Combine(_root, "gone"), _copy);
        File.WriteAllText(Path.Combine(_base, BaseLayout.MarkerFile),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = BaseLayout.Format - 3 }));
        _kit = Path.Combine(_root, "agents-kit");

        var file = TestBases.File(_root, _base);
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", file), new("HealthIntervalSeconds", "3600")]);
            });
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<ITerminalWindows>();
                services.AddSingleton<ITerminalWindows>(_terminals);
            });
        });
    }

    private HttpClient Client => _factory.CreateClient();

    private string Called(string name) =>
        File.Exists(Path.Combine(_kit, "scripts", name)) ? File.ReadAllText(Path.Combine(_kit, "scripts", name)).Trim() : "";

    private async Task SetKit(string migrate, string sync = Pushes, int kitFormat = BaseLayout.Format)
    {
        TestKit.Create(_kit, linkState: $"function Get-KitFormat {{ {kitFormat} }}");
        File.WriteAllText(KitBaseMigrate.ScriptFile(_kit), migrate);
        File.WriteAllText(KitSync.ScriptFile(_kit), sync);
        (await Client.PutAsJsonAsync("/api/kit", new SetKitRequest(_kit))).EnsureSuccessStatusCode();
    }

    private async Task<string> Migrate(string? name = null)
    {
        var response = await Client.PostAsJsonAsync("/api/bases/migrate", new BaseMigrateRequest(_base, name));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<BaseMigrateResponse>())!.Outcome;
    }

    [Fact]
    public async Task Migrate_KitTranslates_FromFirstCopyOnDiskAndPushesBase()
    {
        await SetKit(Translates);

        Assert.Equal(BaseMigrateOutcome.Migrated, await Migrate());

        Assert.Equal($"{_copy}|", Called("migrate.txt"));
        Assert.Equal($"Push Base {_copy}", Called("sync.txt"));
        Assert.False(BaseLayout.IsOutdated(_base));
    }

    [Fact]
    // Сервер недоступен — база уже переведена, а на сервер уйдёт при следующей отдаче агентом.
    public async Task Migrate_PushFails_IsNotPushed()
    {
        await SetKit(Translates, sync: """
            param([string]$Path, [string]$Repo, [string]$Action)
            Write-Host 'remote базы недоступен'
            exit 2
            """);

        Assert.Equal(BaseMigrateOutcome.NotPushed, await Migrate());
        Assert.False(BaseLayout.IsOutdated(_base));
    }

    [Fact]
    public async Task Migrate_StepFails_IsFailedWithoutPush()
    {
        await SetKit("""
            param([string]$Path, [string]$Operator)
            throw 'шаг перевода на формат 6 (flow) не прошёл: что-то — его правки в базе откачены, база осталась формата 5'
            """);

        Assert.Equal(BaseMigrateOutcome.Failed, await Migrate());
        Assert.Equal("", Called("sync.txt"));
    }

    [Fact]
    public async Task Migrate_KitAsksForOperator_NeedsName()
    {
        await SetKit("""
            param([string]$Path, [string]$Operator)
            throw 'имя оператора на этой машине не названо — перевести с -Operator <имя>: латиница в нижнем регистре, цифры и дефис между ними'
            """);

        Assert.Equal(BaseMigrateOutcome.NeedName, await Migrate());
    }

    [Fact]
    // Оператора в файле машины нет — имя спрашивается до кита: без него кит перевод не начнёт.
    public async Task Migrate_NoOperatorOnMachine_NeedsNameWithoutKit()
    {
        TestLayout.Machine(_base, null, _copy);
        await SetKit(Translates);

        Assert.Equal(BaseMigrateOutcome.NeedName, await Migrate());
        Assert.Equal("", Called("migrate.txt"));
    }

    [Fact]
    public async Task Migrate_WithName_PassesOperatorToKit()
    {
        TestLayout.Machine(_base, null, _copy);
        await SetKit(Translates);

        Assert.Equal(BaseMigrateOutcome.Migrated, await Migrate(" b-ignatyev "));
        Assert.Equal($"{_copy}|b-ignatyev", Called("migrate.txt"));
    }

    [Theory]
    [InlineData("Борис")]
    [InlineData("b--ignatyev")]
    public async Task Migrate_NameNotByForm_IsInvalidWithoutKit(string name)
    {
        await SetKit(Translates);

        Assert.Equal(BaseMigrateOutcome.InvalidName, await Migrate(name));
        Assert.Equal("", Called("migrate.txt"));
    }

    [Fact]
    // Кит старше панели перевёл бы базу на формат, которого панель не прочтёт: его обновляют в «Настройках».
    public async Task Migrate_KitKnowsOlderFormat_IsKitOldWithoutMigration()
    {
        await SetKit(Translates, kitFormat: BaseLayout.Format - 1);

        Assert.Equal(BaseMigrateOutcome.KitOld, await Migrate());
        Assert.Equal("", Called("migrate.txt"));
    }

    [Fact]
    public async Task Migrate_KitHasNothingToDoButBaseStaysOld_IsKitOld()
    {
        await SetKit("""
            param([string]$Path, [string]$Operator)
            Write-Host 'База уже формата 5 — переводить нечего.'
            """);

        Assert.Equal(BaseMigrateOutcome.KitOld, await Migrate());
    }

    [Fact]
    public async Task Migrate_KitNotSet_IsKitMissing() =>
        Assert.Equal(BaseMigrateOutcome.KitMissing, await Migrate());

    [Fact]
    public async Task Migrate_BaseNotInList_IsNotFound()
    {
        await SetKit(Translates);
        var other = Directory.CreateDirectory(Path.Combine(_root, "other-knowledge")).FullName;

        var response = await Client.PostAsJsonAsync("/api/bases/migrate", new BaseMigrateRequest(other, null));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    // Два нажатия подряд — один перевод: второй запрос ждёт итога первого, а не зовёт кит поверх.
    public async Task Migrate_Twice_RunsKitOnce()
    {
        await SetKit($$"""
            param([string]$Path, [string]$Operator)
            Add-Content -LiteralPath (Join-Path $PSScriptRoot 'runs.txt') -Value 'перевод' -Encoding utf8
            Start-Sleep -Seconds 2
            Set-Content -LiteralPath '{{Path.Combine(_base, BaseLayout.MarkerFile)}}' -Value '{"kit":"agents-kit","version":{{BaseLayout.Format}}}' -Encoding utf8
            """);

        var outcomes = await Task.WhenAll(Migrate(), Migrate());

        Assert.All(outcomes, o => Assert.Equal(BaseMigrateOutcome.Migrated, o));
        Assert.Single(File.ReadAllLines(Path.Combine(_kit, "scripts", "runs.txt")));
    }

    [Fact]
    public async Task Terminal_OpensFirstCopyOnDisk()
    {
        var response = await Client.PostAsJsonAsync("/api/bases/terminal", new BaseTerminalRequest(_base));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal([_copy], _terminals.Opened);
    }

    public void Dispose()
    {
        TestHost.Stop(_factory);
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (UnauthorizedAccessException)
        {
            // git оставляет файлы только для чтения в .git — их хвост во временном каталоге не мешает прогону.
        }
    }

    private sealed class FakeTerminals : ITerminalWindows
    {
        public List<string> Opened { get; } = [];

        public Task<bool> AttachAsync(string copyPath, string sessionId, CancellationToken cancellationToken) => Task.FromResult(true);

        public Task<bool> OpenAsync(string copyPath, CancellationToken cancellationToken)
        {
            Opened.Add(copyPath);
            return Task.FromResult(true);
        }
    }
}
