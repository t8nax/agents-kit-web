using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Задача трекера, назначенная на оператора. Name — как её называет кит: «GitHub #37», «YouTrack ABC-12»;
/// Number — число номера. Labels — метки задачи GitHub (B-305); у YouTrack и у заведённой панелью задачи их нет.
/// </summary>
public sealed record TrackerIssue(string Name, int Number, string Title, string Url, IReadOnlyList<string>? Labels = null)
{
    public IReadOnlyList<string>? Labels { get; init; } = Labels ?? [];

    /// <summary>Номер без имени трекера — как на плашке задачи: «#37», «ABC-12».</summary>
    [JsonIgnore]
    public string Label => Name[(Name.IndexOf(' ') + 1)..];

    // Метки сравниваются по значению: задача, прочитанная дважды, — та же задача.
    public bool Equals(TrackerIssue? other) =>
        other is not null && Name == other.Name && Number == other.Number && Title == other.Title && Url == other.Url
        && (Labels ?? []).SequenceEqual(other.Labels ?? []);

    public override int GetHashCode() => HashCode.Combine(Name, Number, Title, Url);
}

/// <summary>
/// Задачи трекера базы. Problem задан — задач панель не прочитала: вид трекера из TrackerInfo («other»,
/// «no-keys», «unreadable»), «no-tracker». У GitHub: «gh-missing» — нет программы gh, «gh-login» — gh не вошла
/// в аккаунт GitHub, «repo-unreachable» — репозитория нет или к нему нет доступа (GitHub их не различает),
/// «github-error» — GitHub отказал иначе, Detail — его строка. У YouTrack: «no-key» — ключа к серверу нет
/// в «Настройках», «key-unreadable» — ключ в «Настройках» есть, но на этом компьютере его не прочитать, «key-rejected» —
/// сервер ключ отклонил, «key-forbidden» — ключ принят, но у его владельца нет прав
/// на это действие, «server-silent» — сервер не ответил, «project-missing» —
/// проекта нет или к нему нет доступа, «youtrack-error» — YouTrack отказал иначе, Detail — его строка.
/// «filter-rejected» — YouTrack не принял строку «фильтр:» описания (B-300), Detail — его строка; поиск GitHub
/// фильтр не отвергает.
/// Labels — все метки репозитория GitHub, перечень фильтра «Метки» (B-305); null — трекер не GitHub или меток
/// прочитать не вышло, и фильтр предлагает метки прочитанных задач.
/// </summary>
public sealed record TrackerIssues(
    IReadOnlyList<TrackerIssue> Issues, string? Problem = null, string? Detail = null, IReadOnlyList<string>? Labels = null)
{
    public const string NoTracker = "no-tracker";
    public const string GhMissing = "gh-missing";
    public const string GhLogin = "gh-login";
    public const string RepoUnreachable = "repo-unreachable";
    public const string GitHubError = "github-error";
    public const string NoKey = "no-key";
    public const string KeyRejected = "key-rejected";
    public const string KeyForbidden = "key-forbidden";
    public const string KeyUnreadable = "key-unreadable";
    public const string ServerSilent = "server-silent";
    public const string ProjectMissing = "project-missing";
    public const string YouTrackError = "youtrack-error";
    public const string FilterRejected = "filter-rejected";
}

/// <summary>
/// Задача, заведённая в трекере. Problem задан — задача не заведена, значения те же, что у TrackerIssues;
/// «github-silent» и «youtrack-silent» — трекер не ответил в срок, «created-unknown» — трекер не назвал номер
/// задачи: во всех трёх случаях задача могла завестись.
/// </summary>
public sealed record CreatedIssue(TrackerIssue? Issue, string? Problem = null, string? Detail = null)
{
    public const string GitHubSilent = "github-silent";
    public const string YouTrackSilent = "youtrack-silent";
    public const string CreatedUnknown = "created-unknown";

    /// <summary>Задача могла завестись, хотя её адреса нет: повторять заведение вслепую — завести дубль.</summary>
    public bool MaybeCreated => Problem is GitHubSilent or YouTrackSilent or CreatedUnknown;
}

public interface IGitHubIssues
{
    /// <summary>
    /// Открытые задачи репозитория «владелец/репозиторий», назначенные на того, кем gh вошла в GitHub; filter — строка
    /// поиска GitHub из описания трекера (B-300), null — без отбора.
    /// </summary>
    Task<TrackerIssues> AssignedAsync(string repo, string? filter, CancellationToken cancellationToken);

    /// <summary>Новая задача репозитория, назначенная на того, кем gh вошла в GitHub, без меток.</summary>
    Task<CreatedIssue> CreateAsync(string repo, string title, string body);

    /// <summary>Имена всех меток репозитория; не прочитали — null.</summary>
    Task<IReadOnlyList<string>?> LabelsAsync(string repo, CancellationToken cancellationToken);
}

/// <summary>
/// Задачи GitHub читает и заводит программа gh оператора: вход в аккаунт — её, панель ключей не хранит — решение
/// оператора на B-277. Заводит панель только задачу из записи бэклога (B-286); назначает взятую задачу и меняет
/// её состояние сессия, которая её берёт.
/// </summary>
public sealed partial class GhIssues : IGitHubIssues
{
    public const string Gh = "gh";

    private const int Limit = 100;

    private const int LabelLimit = 1000;

    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(1);

    public async Task<TrackerIssues> AssignedAsync(string repo, string? filter, CancellationToken cancellationToken)
    {
        var run = await RunAsync(StartInfo(repo, filter), null, cancellationToken);
        if (run.Missing)
            return new TrackerIssues([], TrackerIssues.GhMissing);
        if (run.TimedOut)
            return new TrackerIssues([], TrackerIssues.GitHubError, "GitHub не ответил за минуту");
        if (run.ExitCode == 0)
            return Parse(run.Output);
        return Failed(run.ExitCode, run.Error);
    }

    /// <summary>
    /// Отмены у заведения нет: оборванная посреди запроса, gh могла успеть завести задачу, и панель не знала бы
    /// её адреса. Её гасит только срок, и тогда оператор узнаёт, что задачу стоит поискать в трекере.
    /// </summary>
    public async Task<CreatedIssue> CreateAsync(string repo, string title, string body)
    {
        var run = await RunAsync(CreateStartInfo(repo, title), body, CancellationToken.None);
        if (run.Missing)
            return new CreatedIssue(null, TrackerIssues.GhMissing);
        if (run.TimedOut)
            return new CreatedIssue(null, CreatedIssue.GitHubSilent, "GitHub не ответил за минуту");
        if (run.ExitCode != 0)
        {
            var failed = Failed(run.ExitCode, run.Error);
            return new CreatedIssue(null, failed.Problem, failed.Detail);
        }
        return ParseCreated(run.Output, title);
    }

    /// <summary>
    /// Метки — перечень фильтра, а не задачи: не прочитали — оператор видит метки задач, и причину отказа gh
    /// назовёт чтение задач тем же запуском рядом.
    /// </summary>
    public async Task<IReadOnlyList<string>?> LabelsAsync(string repo, CancellationToken cancellationToken)
    {
        var run = await RunAsync(LabelsStartInfo(repo), null, cancellationToken);
        return run is { Missing: false, TimedOut: false, ExitCode: 0 } ? ParseLabels(run.Output) : null;
    }

    /// <summary>Чем кончился запуск gh: Missing — программы нет, TimedOut — не уложилась в срок.</summary>
    public sealed record Run(bool Missing, bool TimedOut, int ExitCode, string Output, string Error);

    /// <summary>Запуск gh с вводом input; открыт тестам — отказ, не дочитавший ввод, проверяется настоящим процессом.</summary>
    public static async Task<Run> RunAsync(ProcessStartInfo startInfo, string? input, CancellationToken cancellationToken)
    {
        Process? process;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Win32Exception)
        {
            return new Run(true, false, -1, "", "");
        }
        if (process is null)
            return new Run(true, false, -1, "", "");

        using (process)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                if (input is not null)
                {
                    try
                    {
                        await process.StandardInput.WriteAsync(input.AsMemory(), timeout.Token);
                        process.StandardInput.Close();
                    }
                    catch (IOException)
                    {
                        // gh отказала раньше, чем прочла ввод (без входа она выходит сразу): канал закрыт, а причину
                        // скажут её код выхода и вывод ошибок.
                    }
                }
                var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);
                var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
                var error = (await errorTask).Trim();
                await process.WaitForExitAsync(timeout.Token);
                return new Run(false, false, process.ExitCode, output, error);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new Run(false, true, -1, "", "");
            }
            finally
            {
                // Брошенная на отмене или сроке, gh работала бы впустую — гасится и дожидается выхода.
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
    /// критерия B-277 держат именно эти ключи. Строка «фильтр:» описания трекера уходит в --search (B-300): gh
    /// сочетает её с назначенным и состоянием. Поиск GitHub фильтр не отвергает — непонятное в нём просто ничего
    /// не находит (проверено настоящей gh на ревью B-300: «label:», неизвестный квалификатор, 280 знаков — пустой
    /// список с кодом 0), поэтому отказа фильтра у GitHub нет, и ошибка gh с фильтром — та же, что без него.
    /// Фильтр — в скобках: gh склеивает его с назначенным и состоянием в одну строку поиска, и «OR» без скобок
    /// вывел бы поиск за открытые задачи оператора — настоящая gh с «is:closed OR is:open» вернула закрытую
    /// (ревью B-300).
    /// </summary>
    public static ProcessStartInfo StartInfo(string repo, string? filter = null) =>
        GhStartInfo(
        [
            "issue", "list", "--repo", repo, "--assignee", "@me", "--state", "open",
            .. string.IsNullOrWhiteSpace(filter) ? Array.Empty<string>() : ["--search", $"({filter.Trim()})"],
            "--limit", Limit.ToString(), "--json", "number,title,url,labels",
        ]);

    /// <summary>Запуск gh: все метки репозитория по имени — перечень фильтра «Метки» (B-305).</summary>
    public static ProcessStartInfo LabelsStartInfo(string repo) =>
        GhStartInfo("label", "list", "--repo", repo, "--limit", LabelLimit.ToString(), "--sort", "name", "--json", "name");

    /// <summary>
    /// Запуск gh на заведение задачи: назначена на того, кем gh вошла, без меток — критерий B-286. Описание
    /// уходит во ввод (`--body-file -`), а не аргументом: длинный текст с кавычками и переводами строк
    /// командная строка Windows не донесла бы как есть.
    /// </summary>
    public static ProcessStartInfo CreateStartInfo(string repo, string title)
    {
        var startInfo = GhStartInfo(
            "issue", "create", "--repo", repo, "--title", title, "--body-file", "-", "--assignee", "@me");
        startInfo.RedirectStandardInput = true;
        startInfo.StandardInputEncoding = new UTF8Encoding(false);
        return startInfo;
    }

    /// <summary>Запуск gh без окна и без вопросов; им же выкладка панели в Стабильный зовёт gh.</summary>
    public static ProcessStartInfo GhStartInfo(params string[] args)
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
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        // gh не должна спрашивать и открывать браузер: отвечать ей некому.
        startInfo.Environment["GH_PROMPT_DISABLED"] = "1";
        startInfo.Environment["GH_NO_UPDATE_NOTIFIER"] = "1";
        return startInfo;
    }

    /// <summary>
    /// gh issue create печатает адрес заведённой задачи последней строкой; номер — хвост адреса. Адреса нет —
    /// задача, скорее всего, заведена, но панель её не знает, и оператору это говорится.
    /// </summary>
    public static CreatedIssue ParseCreated(string output, string title)
    {
        var url = output.ReplaceLineEndings("\n").Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);
        var match = url is null ? null : IssueUrl().Match(url);
        if (match is null || !match.Success)
            return new CreatedIssue(null, CreatedIssue.CreatedUnknown);
        var number = int.Parse(match.Groups[1].Value);
        return new CreatedIssue(new TrackerIssue($"GitHub #{number}", number, title, url!));
    }

    // Хост любой: у GitHub Enterprise задача живёт на его сервере.
    [GeneratedRegex(@"^https://[^/\s]+/[^/\s]+/[^/\s]+/issues/(\d+)$")]
    private static partial Regex IssueUrl();

    /// <summary>
    /// Отказ gh: без входа она выходит с кодом 4 и зовёт «gh auth login», с негодным ключом — 401 Bad credentials;
    /// прочее — строка GitHub как есть.
    /// </summary>
    public static TrackerIssues Failed(int exitCode, string error)
    {
        var line = error.ReplaceLineEndings("\n").Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim();
        // Чужой закрытый репозиторий GitHub отвечает так же, как несуществующий; его строка — причиной рядом.
        // Раньше признаков входа: «401» бывает и в имени репозитория.
        if (error.Contains("Could not resolve to a Repository", StringComparison.Ordinal))
            return new TrackerIssues([], TrackerIssues.RepoUnreachable, line);
        if (exitCode == 4 || error.Contains("gh auth login", StringComparison.Ordinal)
            || error.Contains("401 Unauthorized", StringComparison.Ordinal) || error.Contains("Bad credentials", StringComparison.Ordinal))
            return new TrackerIssues([], TrackerIssues.GhLogin);
        return new TrackerIssues([], TrackerIssues.GitHubError, line ?? $"gh вышла с кодом {exitCode}");
    }

    public static TrackerIssues Parse(string output)
    {
        try
        {
            var issues = JsonSerializer.Deserialize<List<GhIssue>>(output) ?? [];
            return new TrackerIssues(issues.Select(i => new TrackerIssue(
                $"GitHub #{i.Number}", i.Number, i.Title, i.Url, (i.Labels ?? []).Select(l => l.Name).ToList())).ToList());
        }
        catch (JsonException)
        {
            return new TrackerIssues([], TrackerIssues.GitHubError, "Ответ gh не разобран");
        }
    }

    private sealed record GhIssue(
        [property: JsonPropertyName("number")] int Number,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("labels")] List<GhLabel>? Labels = null);

    public static IReadOnlyList<string>? ParseLabels(string output)
    {
        try
        {
            return (JsonSerializer.Deserialize<List<GhLabel>>(output) ?? []).Select(l => l.Name).ToList();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record GhLabel([property: JsonPropertyName("name")] string Name);
}
