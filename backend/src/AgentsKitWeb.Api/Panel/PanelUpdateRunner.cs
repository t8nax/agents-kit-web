using System.Diagnostics;

namespace AgentsKitWeb.Api.Panel;

/// <summary>
/// Чем кончилось или чем занято обновление, последние строки его журнала и путь к журналу целиком:
/// сорвавшуюся сборку дочитывают в файле, и панель даёт оператору его скопировать.
/// </summary>
public sealed record PanelUpdateState(string State, string? Version, IReadOnlyList<string> Log, string File);

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
/// себя сама — публикация гасит её и сносит её каталог, — поэтому запущенное ей не принадлежит:
/// свой процесс, свой рабочий каталог вне подменяемого и свой журнал рядом с каталогом панели.
/// </summary>
public sealed class PanelUpdateRunner(string logFile)
{
    private const string Started = "[начало]";
    private const string Finished = "[конец]";
    private const string FinishedOk = "[конец] готово";

    /// <summary>Сколько строк журнала показывается оператору: весь вывод сборки ему не нужен.</summary>
    private const int Tail = 12;

    private readonly Lock _lock = new();

    /// <summary>Рядом с каталогом панели, а не в нём: подмена сносит каталог вместе с журналом.</summary>
    public static string FileBeside(string publishedFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(publishedFile))!)!, "update.log");

    public string File { get; } = logFile;

    public PanelUpdateState Read()
    {
        var lines = Lines();
        if (lines.Count == 0)
            return new PanelUpdateState(PanelUpdateStates.None, null, [], File);

        var tail = lines.TakeLast(Tail).ToList();
        var end = lines.LastOrDefault(line => line.StartsWith(Finished, StringComparison.Ordinal));
        if (end is null)
            return new PanelUpdateState(PanelUpdateStates.Running, null, tail, File);
        return end.StartsWith(FinishedOk, StringComparison.Ordinal)
            ? new PanelUpdateState(PanelUpdateStates.Done, end[FinishedOk.Length..].Trim(), tail, File)
            : new PanelUpdateState(PanelUpdateStates.Failed, null, tail, File);
    }

    /// <summary>Уже идёт — второй раз не запускаем: две подмены одного каталога встретились бы на полпути.</summary>
    public bool Start(PublishedPanel published, string channel)
    {
        lock (_lock)
        {
            if (Read().State == PanelUpdateStates.Running)
                return false;

            var script = Path.Combine(published.Repository, "scripts", "update.ps1");
            var startInfo = new ProcessStartInfo("pwsh")
            {
                // Рабочий каталог — репозиторий: из подменяемого каталога панели процесс не даст его снести.
                WorkingDirectory = published.Repository,
                UseShellExecute = false,
                // Поставленная панель — WinExe без консоли: без этого Windows открывает окно обновления.
                CreateNoWindow = true,
            };
            string[] arguments =
            [
                "-NoProfile", "-File", script,
                "-Channel", channel,
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
            WriteStart(channel);
            using var process = Process.Start(startInfo);
            return process is not null;
        }
    }

    private void WriteStart(string channel)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(File))!);
            System.IO.File.WriteAllText(File, $"{Started} канал {channel}{Environment.NewLine}");
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
}
