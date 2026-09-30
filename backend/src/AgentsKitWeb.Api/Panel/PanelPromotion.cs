using System.Collections.Concurrent;
using System.Text.Json;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Блок «Выкладка в Стабильный» карточки «Панель». Stable — последний выпуск Стабильного, null — выпусков ещё нет.
/// State: «ready» — стоящую Бету можно выложить; «running» — выкладка идёт; «failed» — последняя выкладка этой
/// сборки сорвалась, её можно повторить; «already» — стоящая сборка уже в Стабильном; «older» — в Стабильном
/// сборка новее стоящей, выкладывать нечего; «no-rights» — у вошедшего в GitHub нет права менять репозиторий
/// выпусков, и выкладка ему не дана.
/// </summary>
public sealed record PanelStableResponse(string Version, string? Stable, string State);

/// <summary>Последний запуск выкладки сборки: Status — queued, in_progress или completed; Conclusion — у завершённого.</summary>
public sealed record PromotionRun(string Status, string? Conclusion, DateTimeOffset CreatedAt)
{
    public bool Running => Status != "completed";

    public bool Succeeded => Status == "completed" && Conclusion == "success";
}

/// <summary>Выкладка в Стабильный идёт на GitHub — promote.yml — от имени того, кем программа gh вошла в GitHub.</summary>
public interface IPanelPromotion
{
    /// <summary>Можно ли вошедшему менять репозиторий выпусков; gh нет, не вошла или не ответила — нельзя.</summary>
    Task<bool> CanPromoteAsync(string repository, CancellationToken cancellationToken);

    /// <summary>Последний запуск выкладки сборки <paramref name="version"/>; не было или не прочитать — null.</summary>
    Task<PromotionRun?> LastRunAsync(string repository, string version, CancellationToken cancellationToken);

    /// <summary>Запускает выкладку; запустилась — null, иначе строка отказа gh.</summary>
    Task<string?> StartAsync(string repository, string version);
}

public static class PanelPromotions
{
    public const string Workflow = "promote.yml";

    /// <summary>Заголовок запуска выкладки — run-name в promote.yml: по нему находится запуск нужной сборки.</summary>
    public static string Title(string version) => $"Выкладка {version} в Стабильный";

    /// <summary>
    /// Запуск GitHub показывает не сразу после `gh workflow run`: пока его нет в списке, выкладка, начатая
    /// отсюда, считается идущей — иначе блок на полминуты вернул бы кнопку.
    /// </summary>
    public static readonly TimeSpan Appearing = TimeSpan.FromMinutes(2);

    /// <summary>Последний запуск выкладки сборки из вывода `gh run list --json displayTitle,status,conclusion,createdAt`.</summary>
    public static PromotionRun? ParseLastRun(string json, string version)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateArray()
            .Where(run => run.GetProperty("displayTitle").GetString() == Title(version))
            .Select(run => new PromotionRun(
                run.GetProperty("status").GetString() ?? "",
                run.TryGetProperty("conclusion", out var conclusion) ? conclusion.GetString() : null,
                run.GetProperty("createdAt").GetDateTimeOffset()))
            .OrderByDescending(run => run.CreatedAt)
            .FirstOrDefault();
    }
}

/// <summary>Когда панель последний раз запустила выкладку какой сборки — до появления запуска на GitHub.</summary>
public sealed class PanelPromotionStarts
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _started = new();

    public void Started(string version, DateTimeOffset at) => _started[version] = at;

    public DateTimeOffset? StartedAt(string version) => _started.TryGetValue(version, out var at) ? at : null;
}

/// <summary>Выкладка через программу gh оператора: вход в GitHub — её, панель ключей не хранит (как у задач GitHub).</summary>
public sealed class GhPromotion(TimeProvider time) : IPanelPromotion
{
    private static readonly TimeSpan RightsFresh = TimeSpan.FromMinutes(5);

    private const int Runs = 20;

    // Карточка спрашивает блок каждые несколько секунд, пока идёт выкладка, а право меняется редко.
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, bool Can)> _rights = new();

    public async Task<bool> CanPromoteAsync(string repository, CancellationToken cancellationToken)
    {
        if (_rights.TryGetValue(repository, out var cached) && time.GetUtcNow() - cached.At < RightsFresh)
            return cached.Can;
        var run = await GhIssues.RunAsync(
            GhIssues.GhStartInfo("api", $"repos/{repository}", "--jq", ".permissions.push"), null, cancellationToken);
        var can = run is { Missing: false, TimedOut: false, ExitCode: 0 } && run.Output.Trim() == "true";
        _rights[repository] = (time.GetUtcNow(), can);
        return can;
    }

    public async Task<PromotionRun?> LastRunAsync(string repository, string version, CancellationToken cancellationToken)
    {
        var run = await GhIssues.RunAsync(
            GhIssues.GhStartInfo(
                "run", "list", "--repo", repository, "--workflow", PanelPromotions.Workflow, "--limit", Runs.ToString(),
                "--json", "displayTitle,status,conclusion,createdAt"),
            null, cancellationToken);
        if (run is not { Missing: false, TimedOut: false, ExitCode: 0 })
            return null;
        try
        {
            return PanelPromotions.ParseLastRun(run.Output, version);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or KeyNotFoundException
                                              or FormatException)
        {
            return null;
        }
    }

    public async Task<string?> StartAsync(string repository, string version)
    {
        var run = await GhIssues.RunAsync(
            GhIssues.GhStartInfo(
                "workflow", "run", PanelPromotions.Workflow, "--repo", repository, "-f", $"version={version}"),
            null, CancellationToken.None);
        return run.Missing ? "Программы gh нет на этом компьютере."
            : run.TimedOut ? "GitHub не ответил за минуту."
            : run.ExitCode == 0 ? null
            : string.IsNullOrWhiteSpace(run.Error) ? $"gh завершилась с кодом {run.ExitCode}." : run.Error;
    }
}
