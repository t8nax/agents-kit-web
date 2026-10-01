using System.Collections.Concurrent;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Bases;

public sealed record BaseMigrateRequest(string? Base, string? Operator);

/// <summary>Чем кончился перевод базы — значение BaseMigrateOutcome.</summary>
public sealed record BaseMigrateResponse(string Outcome);

public sealed record BaseTerminalRequest(string? Base);

/// <summary>
/// Итоги перевода, какими их видит оператор (B-314). Слова кита оператору не показываются — «это технические детали»,
/// решение оператора к макету: что не так, панель говорит своей фразой, а чинить идут в терминал копии.
/// </summary>
public static class BaseMigrateOutcome
{
    /// <summary>Переведена и отдана на сервер — база просто становится обычной.</summary>
    public const string Migrated = "migrated";

    /// <summary>Переведена, а на сервер не ушла: сервер недоступен — уйдёт при следующей отдаче агентом.</summary>
    public const string NotPushed = "not-pushed";

    /// <summary>Переведена, а на сервер не ушла по другой причине — её слова кита оператору не показываются.</summary>
    public const string NotSynced = "not-synced";

    /// <summary>Киту нужно имя оператора этой машины.</summary>
    public const string NeedName = "need-name";

    /// <summary>Имя оператора не по форме кита.</summary>
    public const string InvalidName = "invalid-name";

    /// <summary>Кит не знает формата, которого ждёт панель, — его обновляют в «Настройках».</summary>
    public const string KitOld = "kit-old";

    /// <summary>Пути к киту нет или в нём нет скрипта перевода — тоже в «Настройки».</summary>
    public const string KitMissing = "kit-missing";

    public const string Failed = "failed";
}

public static class BaseMigrateEndpoints
{
    public static void MapBaseMigrateEndpoints(this IEndpointRouteBuilder app)
    {
        // Переводит кит, а не панель: шаги перевода, их коммиты и откат сорванного — его. Подтверждения нет —
        // переводится сразу по кнопке, решение оператора на B-314.
        app.MapPost("/api/bases/migrate", async (BaseMigrateRequest request, BasesStore bases, HealthMonitor health) =>
        {
            // Переводится только база из списка панели: путь по HTTP не принимается.
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base ?? ""));
            if (basePath is null)
                return Results.NotFound();

            var outcome = await KitBaseMigrate.MigrateAsync(bases.Kit(), basePath, request.Operator);
            health.RequestCheck();
            return Results.Ok(new BaseMigrateResponse(outcome));
        });

        // Терминал в той копии, от которой шёл перевод: в ней кит и чинят руками.
        app.MapPost("/api/bases/terminal", async (
            BaseTerminalRequest request, BasesStore bases, ITerminalWindows terminals, CancellationToken cancellationToken) =>
        {
            var basePath = bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base ?? ""));
            if (basePath is null || KitBaseMigrate.Copy(basePath) is not { } copy)
                return Results.NotFound();
            return await terminals.OpenAsync(copy, cancellationToken) ? Results.Ok() : Results.Problem("Терминал не открылся");
        });
    }
}

/// <summary>Перевод базы прежнего формата скриптом кита base-migrate.ps1 — от копии базы этой машины.</summary>
public static class KitBaseMigrate
{
    // Перевод коммитит шаг за шагом: по сроку панель только перестаёт его ждать, а скрипт доходит сам.
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);

    // Переводы по базе: второй запрос, пока идёт первый, ждёт его итога, а не запускает кит второй раз поверх.
    private static readonly ConcurrentDictionary<string, Task<string>> Running = new(StringComparer.OrdinalIgnoreCase);

    public static string ScriptFile(string kit) => Path.Combine(kit, "scripts", "base-migrate.ps1");

    /// <summary>Копия, от которой переводят: первая копия базы этой машины, что есть на диске, — как у заведения копии.</summary>
    public static string? Copy(string basePath) => WorkspaceCollector.NewCopySource(BaseLayout.MachineCopies(basePath));

    // Формат, который знает кит, команда сверяет до перевода (Get-KitFormat его link-state.ps1): кит старше панели
    // перевёл бы базу на формат, которого панель всё равно не прочтёт. Путь, имя и формат — переменными окружения.
    // Отказ кит делает через throw — скрипт печатает сам текст, иначе pwsh отдаёт его в CLIXML.
    private const string Command = """
        $PSStyle.OutputRendering = 'PlainText'
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $ErrorActionPreference = 'Stop'
        try {
            . (Join-Path (Split-Path $env:AKW_SCRIPT -Parent) 'link-state.ps1')
            if ((Get-KitFormat) -lt [int]$env:AKW_FORMAT) { 'AKW_KIT_OLD'; exit 0 }
            $a = @{ Path = $env:AKW_COPY }
            if ($env:AKW_OPERATOR) { $a.Operator = $env:AKW_OPERATOR }
            & $env:AKW_SCRIPT @a 6>&1 | ForEach-Object { "$_" }
        }
        catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            exit 1
        }
        exit 0
        """;

    /// <summary>Начало отказа кита, когда он просит имя оператора (base-migrate.ps1): других признаков у отказа нет.</summary>
    public const string NoOperatorRefusal = "имя оператора на этой машине не названо";

    public static Task<string> MigrateAsync(string? kit, string basePath, string? operatorName)
    {
        var key = WorkspaceCollector.Normalize(basePath);
        lock (Running)
        {
            if (Running.TryGetValue(key, out var running))
                return running;
            var task = RunAsync(kit, basePath, operatorName, key);
            if (!task.IsCompleted)
                Running[key] = task;
            return task;
        }
    }

    private static async Task<string> RunAsync(string? kit, string basePath, string? operatorName, string key)
    {
        Task? rest = null;
        try
        {
            if (kit is null || !File.Exists(ScriptFile(kit)))
                return BaseMigrateOutcome.KitMissing;
            if (Copy(basePath) is not { } copy)
                return BaseMigrateOutcome.Failed;

            // Сначала базу забирают с сервера, как велит кит (skills/onboard): её могли перевести с другой машины, и второй
            // перевод поверх устаревшей истории встал бы на конфликте при отдаче. Не забрана — перевод не запускается.
            if (!(await KitSync.RunAsync(KitSync.ScriptFile(kit), copy, KitSync.Pull)).Done)
                return BaseMigrateOutcome.Failed;
            // Базу уже перевели — с другой машины, соседней сессией или прошлым переводом, которого панель не дождалась.
            if (!BaseLayout.IsOutdated(basePath))
                return BaseMigrateOutcome.Migrated;

            var name = string.IsNullOrWhiteSpace(operatorName) ? null : operatorName.Trim();
            if (name is not null && !BaseLayout.IsOperatorName(name))
                return BaseMigrateOutcome.InvalidName;
            if (name is null && BaseLayout.MachineOperator(basePath) is null)
                return BaseMigrateOutcome.NeedName;

            var environment = new Dictionary<string, string>
            {
                ["AKW_SCRIPT"] = ScriptFile(kit),
                ["AKW_COPY"] = copy,
                ["AKW_OPERATOR"] = name ?? "",
                ["AKW_FORMAT"] = BaseLayout.Format.ToString(System.Globalization.CultureInfo.InvariantCulture),
            };
            var run = await KitScriptRunner.RunAsync(Command, environment, Timeout, CancellationToken.None, killOnTimeout: false);
            rest = run.Rest;
            switch (run.Outcome)
            {
                case KitRunOutcome.Refused when run.Error.StartsWith(NoOperatorRefusal, StringComparison.Ordinal):
                    return BaseMigrateOutcome.NeedName;
                case not KitRunOutcome.Ok:
                    return BaseMigrateOutcome.Failed;
            }
            if (run.Output.Split('\n', StringSplitOptions.TrimEntries).Contains("AKW_KIT_OLD"))
                return BaseMigrateOutcome.KitOld;
            // Кит сказал «переводить нечего», а база осталась прежнего формата: его формат и есть формат базы.
            if (BaseLayout.IsOutdated(basePath))
                return BaseMigrateOutcome.KitOld;

            // Переведённую базу панель отдаёт на сервер, как после записи описания трекера (B-293) — решение оператора.
            var push = await KitSync.RunAsync(KitSync.ScriptFile(kit), copy, KitSync.Push);
            return push.Code switch
            {
                0 => BaseMigrateOutcome.Migrated,
                2 => BaseMigrateOutcome.NotPushed,
                _ => BaseMigrateOutcome.NotSynced,
            };
        }
        finally
        {
            // Брошенный по сроку перевод держит базу, пока не дойдёт сам. Под замком: запись о переводе
            // MigrateAsync ставит уже после старта, и снять её раньше постановки нельзя.
            if (rest is null)
                Forget(key);
            else
                _ = rest.ContinueWith(_ => Forget(key), TaskScheduler.Default);
        }
    }

    private static void Forget(string key)
    {
        lock (Running)
            Running.TryRemove(key, out _);
    }
}
