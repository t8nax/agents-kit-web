using System.Diagnostics;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Чем кончилось или чем занято обновление, последние строки его журнала и путь к журналу целиком:
/// сорвавшееся обновление дочитывают в файле, и панель даёт оператору его скопировать. Release — номер
/// выпуска, который ставится; Downloaded и Total — сколько байт архива скачано из скольких;
/// Installing — архив скачан и ставится.
/// </summary>
public sealed record PanelUpdateState(
    string State,
    string? Version,
    IReadOnlyList<string> Log,
    string File,
    string? Release = null,
    long? Downloaded = null,
    long? Total = null,
    bool Installing = false);

public static class PanelUpdateStates
{
    /// <summary>Панель этой копии ещё не обновляли.</summary>
    public const string None = "none";
    public const string Running = "running";
    public const string Done = "done";
    public const string Failed = "failed";
}

/// <summary>
/// Обновление панели: отдельный процесс, который переживает её гашение. Панель не может обновить
/// себя сама — постановка гасит её и сносит её каталог, — поэтому запущенное ей не принадлежит:
/// свой процесс, своя копия скриптов и свой рабочий каталог вне подменяемого и свой журнал рядом
/// с каталогом панели. Скрипты — те, что приехали в сборке панели: исходников рядом с ней нет.
/// </summary>
public sealed partial class PanelUpdateRunner(string logFile, string scriptsDirectory)
{
    private const string Started = "[начало]";
    private const string Finished = "[конец]";
    private const string FinishedOk = "[конец] готово";
    private const string Downloading = "[скачано]";
    private const string Installs = "[ставлю]";

    /// <summary>Сколько строк журнала показывается оператору: весь вывод постановки ему не нужен.</summary>
    private const int Tail = 12;

    private readonly Lock _lock = new();

    /// <summary>Рядом с каталогом панели, а не в нём: подмена сносит каталог вместе с журналом.</summary>
    public static string FileBeside(string publishedFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(publishedFile))!)!, "update.log");

    /// <summary>Скрипты обновления, которые сборка панели везёт с собой.</summary>
    public static string ScriptsInBuild => Path.Combine(AppContext.BaseDirectory, "scripts");

    public string File { get; } = logFile;

    public PanelUpdateState Read()
    {
        var lines = Lines();
        if (lines.Count == 0)
            return new PanelUpdateState(PanelUpdateStates.None, null, [], File);

        // Отметки хода — для шагов окна, а не для чтения: в журнал оператору они не идут.
        var tail = lines
            .Where(line => !line.StartsWith(Downloading, StringComparison.Ordinal) && line != Installs)
            .TakeLast(Tail)
            .ToList();
        var release = lines
            .Select(line => ReleaseLine().Match(line))
            .FirstOrDefault(match => match.Success)?.Groups[1].Value;
        var progress = lines
            .Select(line => ProgressLine().Match(line))
            .LastOrDefault(match => match.Success);
        long? downloaded = progress is null ? null : long.Parse(progress.Groups[1].Value);
        long? total = progress is null ? null : long.Parse(progress.Groups[2].Value);
        var installing = lines.Contains(Installs);

        var end = lines.LastOrDefault(line => line.StartsWith(Finished, StringComparison.Ordinal));
        if (end is null)
            return new PanelUpdateState(PanelUpdateStates.Running, null, tail, File, release, downloaded, total, installing);
        return end.StartsWith(FinishedOk, StringComparison.Ordinal)
            ? new PanelUpdateState(PanelUpdateStates.Done, end[FinishedOk.Length..].Trim(), tail, File, release)
            : new PanelUpdateState(PanelUpdateStates.Failed, null, tail, File, release, downloaded, total, installing);
    }

    /// <summary>Уже идёт — второй раз не запускаем: две подмены одного каталога встретились бы на полпути.</summary>
    public bool Start(PublishedPanel published, string channel, string repository, PanelRelease release)
    {
        lock (_lock)
        {
            if (Read().State == PanelUpdateStates.Running)
                return false;

            // Копия рядом с журналом: из каталога панели процесс не дал бы его снести,
            // а постановка снесла бы скрипт из-под процесса.
            var copy = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(File))!, "update-scripts");
            if (Directory.Exists(copy))
                Directory.Delete(copy, recursive: true);
            Directory.CreateDirectory(copy);
            foreach (var script in Directory.EnumerateFiles(scriptsDirectory, "*.ps1"))
                System.IO.File.Copy(script, Path.Combine(copy, Path.GetFileName(script)));

            var startInfo = new ProcessStartInfo("pwsh")
            {
                WorkingDirectory = copy,
                UseShellExecute = false,
                // Поставленная панель — WinExe без консоли: без этого Windows открывает окно обновления.
                CreateNoWindow = true,
            };
            string[] arguments =
            [
                "-NoProfile", "-File", Path.Combine(copy, "update.ps1"),
                "-Channel", channel,
                "-Tag", release.Tag,
                "-Releases", repository,
                "-Target", published.Target,
                "-Port", published.Port.ToString(),
                "-TaskName", published.TaskName,
                "-Log", File,
            ];
            foreach (var argument in arguments)
                startInfo.ArgumentList.Add(argument);

            // Журнал обнуляется здесь, до запуска: прошлое обновление кончилось строкой «[конец]»,
            // и с ней панель считала бы новое уже завершённым. Дальше журнал ведёт сам скрипт —
            // читать его потоки некому, панель к концу обновления будет мертва.
            WriteStart(channel, release.Version);
            using var process = Process.Start(startInfo);
            return process is not null;
        }
    }

    private void WriteStart(string channel, string release)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(File))!);
            System.IO.File.WriteAllText(File, $"{Started} канал {channel}, выпуск {release}{Environment.NewLine}");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Журнал перехватил уже запущенный скрипт — его строка начала и останется.
        }
    }

    private List<string> Lines()
    {
        try
        {
            if (!System.IO.File.Exists(File))
                return [];
            // Журнал прямо сейчас пишет чужой процесс, поэтому открываем его, ничего не занимая.
            using var stream = new FileStream(File, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd()
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    [GeneratedRegex(@"^\[начало\] .*выпуск (\S+)$")]
    private static partial Regex ReleaseLine();

    [GeneratedRegex(@"^\[скачано\] (\d+) из (\d+)$")]
    private static partial Regex ProgressLine();
}
