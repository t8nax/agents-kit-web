using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>Задача трекера, назначенная на оператора. Name — как её называет кит: «GitHub #37».</summary>
public sealed record TrackerIssue(string Name, int Number, string Title, string Url);

/// <summary>
/// Задачи трекера базы. Problem задан — задач панель не прочитала: вид трекера из TrackerInfo («not-github»,
/// «no-address», «unreadable»), «no-tracker», «gh-missing» — нет программы gh, «gh-login» — gh не вошла
/// в аккаунт GitHub, «repo-unreachable» — репозитория нет или к нему нет доступа (GitHub их не различает),
/// «github-error» — GitHub отказал иначе, Detail — его строка.
/// </summary>
public sealed record TrackerIssues(IReadOnlyList<TrackerIssue> Issues, string? Problem = null, string? Detail = null)
{
    public const string NoTracker = "no-tracker";
    public const string GhMissing = "gh-missing";
    public const string GhLogin = "gh-login";
    public const string RepoUnreachable = "repo-unreachable";
    public const string GitHubError = "github-error";
}

public interface IGitHubIssues
{
    /// <summary>Открытые задачи репозитория «владелец/репозиторий», назначенные на того, кем gh вошла в GitHub.</summary>
    Task<TrackerIssues> AssignedAsync(string repo, CancellationToken cancellationToken);
}

/// <summary>
/// Задачи GitHub читает программа gh оператора: вход в аккаунт — её, панель ключей не хранит — решение
/// оператора на B-277. Панель только читает; назначает задачу и меняет её состояние сессия, которая её берёт.
/// </summary>
public sealed class GhIssues : IGitHubIssues
{
    public const string Gh = "gh";

    private const int Limit = 100;

    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(1);

    public async Task<TrackerIssues> AssignedAsync(string repo, CancellationToken cancellationToken)
    {
        Process? process;
        try
        {
            process = Process.Start(StartInfo(repo));
        }
        catch (Win32Exception)
        {
            return new TrackerIssues([], TrackerIssues.GhMissing);
        }
        if (process is null)
            return new TrackerIssues([], TrackerIssues.GhMissing);

        using (process)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);
                var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
                var error = (await errorTask).Trim();
                await process.WaitForExitAsync(timeout.Token);
                return process.ExitCode == 0 ? Parse(output) : Failed(process.ExitCode, error);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new TrackerIssues([], TrackerIssues.GitHubError, "GitHub не ответил за минуту");
            }
            finally
            {
                // gh только читает: брошенная на отмене или сбое, она работала бы впустую — гасится и дожидается выхода.
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync(CancellationToken.None);
                }
            }
        }
    }

    /// <summary>
    /// Запуск gh: открытые задачи репозитория, назначенные на того, кем gh вошла, — «назначенные на оператора»
    /// критерия B-277 держат именно эти ключи.
    /// </summary>
    public static ProcessStartInfo StartInfo(string repo)
    {
        var startInfo = new ProcessStartInfo(Gh)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            // Поставленная панель — WinExe без консоли: без этого Windows открывает окно на каждый запуск.
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "issue", "list", "--repo", repo, "--assignee", "@me", "--state", "open",
                     "--limit", Limit.ToString(), "--json", "number,title,url",
                 })
            startInfo.ArgumentList.Add(arg);
        // gh не должна спрашивать и открывать браузер: отвечать ей некому.
        startInfo.Environment["GH_PROMPT_DISABLED"] = "1";
        startInfo.Environment["GH_NO_UPDATE_NOTIFIER"] = "1";
        return startInfo;
    }

    /// <summary>
    /// Отказ gh: без входа она выходит с кодом 4 и зовёт «gh auth login», с негодным ключом — 401 Bad credentials;
    /// прочее — строка GitHub как есть.
    /// </summary>
    public static TrackerIssues Failed(int exitCode, string error)
    {
        if (exitCode == 4 || error.Contains("gh auth login", StringComparison.Ordinal)
            || error.Contains("401", StringComparison.Ordinal) || error.Contains("Bad credentials", StringComparison.Ordinal))
            return new TrackerIssues([], TrackerIssues.GhLogin);
        var line = error.ReplaceLineEndings("\n").Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim();
        // Чужой закрытый репозиторий GitHub отвечает так же, как несуществующий; его строка — причиной рядом.
        if (error.Contains("Could not resolve to a Repository", StringComparison.Ordinal))
            return new TrackerIssues([], TrackerIssues.RepoUnreachable, line);
        return new TrackerIssues([], TrackerIssues.GitHubError, line ?? $"gh вышла с кодом {exitCode}");
    }

    public static TrackerIssues Parse(string output)
    {
        try
        {
            var issues = JsonSerializer.Deserialize<List<GhIssue>>(output) ?? [];
            return new TrackerIssues(issues.Select(i => new TrackerIssue($"GitHub #{i.Number}", i.Number, i.Title, i.Url)).ToList());
        }
        catch (JsonException)
        {
            return new TrackerIssues([], TrackerIssues.GitHubError, "Ответ gh не разобран");
        }
    }

    private sealed record GhIssue(
        [property: JsonPropertyName("number")] int Number,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("url")] string Url);
}
