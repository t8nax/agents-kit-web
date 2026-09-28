namespace AgentsKitWeb.Api.Voice;

/// <summary>
/// Состояние модуля голосового ввода: absent — модели нет, downloading — качается, installed — стоит,
/// failed — скачивание сорвалось. Downloaded и Total — байты: ход скачивания или размер стоящей модели;
/// Total null, пока сервер не назвал размер.
/// </summary>
public sealed record VoiceState(string State, long Downloaded, long? Total, string? Error)
{
    public const string Absent = "absent";
    public const string Downloading = "downloading";
    public const string Installed = "installed";
    public const string Failed = "failed";
}

/// <summary>
/// Модель распознавания речи — модуль по желанию оператора (B-291): панель ставится и обновляется без неё,
/// а оператор скачивает её кнопкой в «Настройках». Лежит не в каталоге панели, а рядом с ним: постановка
/// подменяет каталог панели целиком и снесла бы модель с каждым обновлением.
/// Качается во временный файл и переименовывается в модель только целой: срыв и отмена не оставляют
/// полумодели, которую распознавание приняло бы за стоящую.
/// </summary>
public sealed class VoiceModel(string directory, Uri source, IHttpClientFactory clients)
{
    public const string Client = "voice-model";
    public const string FileName = "ggml-large-v3-turbo-q5_0.bin";

    /// <summary>Хранилище авторов whisper.cpp: оттуда модель и берётся, копии у панели нет.</summary>
    public static readonly Uri DefaultSource =
        new("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + FileName);

    /// <summary>
    /// Срок на каждую порцию, а не на всё скачивание: сотни мегабайт идут минутами, а замолчавшая связь
    /// без срока держала бы «Скачивается» навсегда.
    /// </summary>
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(60);

    private readonly Lock _lock = new();
    private CancellationTokenSource? _download;
    private long _downloaded;
    private long? _total;
    private string? _error;

    public static string DefaultDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "agents-kit-web", "voice");

    public string File => Path.Combine(directory, FileName);

    private string PartFile => File + ".part";

    public bool Installed => System.IO.File.Exists(File);

    /// <summary>Модель стоит и её убирают: распознавание отпускает файл до удаления.</summary>
    public event Action? Removing;

    public VoiceState Read()
    {
        lock (_lock)
        {
            if (_download is not null)
                return new VoiceState(VoiceState.Downloading, _downloaded, _total, null);
            if (Installed)
            {
                var size = new FileInfo(File).Length;
                return new VoiceState(VoiceState.Installed, size, size, null);
            }
            // У сорвавшегося — сколько успело скачаться: карточка говорит, на чём прервалось.
            return _error is null
                ? new VoiceState(VoiceState.Absent, 0, null, null)
                : new VoiceState(VoiceState.Failed, _downloaded, _total, _error);
        }
    }

    /// <summary>Уже качается или уже стоит — false: второе скачивание того же файла не начинается.</summary>
    public bool Install()
    {
        CancellationTokenSource download;
        lock (_lock)
        {
            if (_download is not null || Installed)
                return false;
            download = _download = new CancellationTokenSource();
            _downloaded = 0;
            _total = null;
            _error = null;
        }
        _ = Task.Run(() => DownloadAsync(download));
        return true;
    }

    /// <summary>Отмена — не ошибка: карточка возвращается к «Установить», недокачанное убирается.</summary>
    public void Cancel()
    {
        lock (_lock)
            _download?.Cancel();
    }

    /// <summary>Пока модель качается, её не удалить: сперва отменить.</summary>
    public bool Remove()
    {
        lock (_lock)
        {
            if (_download is not null)
                return false;
            _error = null;
        }
        Removing?.Invoke();
        if (Installed)
            System.IO.File.Delete(File);
        return true;
    }

    private async Task DownloadAsync(CancellationTokenSource download)
    {
        try
        {
            Directory.CreateDirectory(directory);
            using var client = clients.CreateClient(Client);
            using var response = await client.GetAsync(source, HttpCompletionOption.ResponseHeadersRead, download.Token);
            response.EnsureSuccessStatusCode();
            lock (_lock)
                _total = response.Content.Headers.ContentLength;
            await using (var input = await response.Content.ReadAsStreamAsync(download.Token))
            await using (var output = new FileStream(PartFile, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                while (true)
                {
                    using var portion = CancellationTokenSource.CreateLinkedTokenSource(download.Token);
                    portion.CancelAfter(ReadTimeout);
                    int read;
                    try
                    {
                        read = await input.ReadAsync(buffer, portion.Token);
                    }
                    catch (OperationCanceledException) when (!download.IsCancellationRequested)
                    {
                        throw new TimeoutException("Сервер перестал отдавать модель.");
                    }
                    if (read == 0)
                        break;
                    await output.WriteAsync(buffer.AsMemory(0, read), download.Token);
                    lock (_lock)
                        _downloaded += read;
                }
            }
            lock (_lock)
                if (_total is { } total && _downloaded != total)
                    throw new IncompleteDownload("Сервер отдал модель не целиком.");
            System.IO.File.Move(PartFile, File, overwrite: true);
        }
        catch (Exception exception)
        {
            DeletePart();
            if (!download.IsCancellationRequested)
                lock (_lock)
                    _error = Reason(exception);
        }
        finally
        {
            lock (_lock)
                _download = null;
            download.Dispose();
        }
    }

    /// <summary>Причина словами оператору: сообщения HttpClient и сокетов приходят по-английски.</summary>
    private static string Reason(Exception exception) => exception switch
    {
        HttpRequestException { StatusCode: { } status } => $"Сервер модели ответил {(int)status}.",
        TimeoutException or IncompleteDownload => exception.Message,
        _ => "Связь с сервером модели прервалась.",
    };

    private sealed class IncompleteDownload(string message) : IOException(message);

    private void DeletePart()
    {
        try
        {
            if (System.IO.File.Exists(PartFile))
                System.IO.File.Delete(PartFile);
        }
        catch (IOException)
        {
            // Недокачанное держит антивирус: его перезапишет следующее скачивание.
        }
    }
}
