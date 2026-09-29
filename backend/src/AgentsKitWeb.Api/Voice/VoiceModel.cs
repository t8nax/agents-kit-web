using System.IO.Compression;

namespace AgentsKitWeb.Api.Voice;

/// <summary>
/// Состояние модуля голосового ввода: absent — модуля нет, downloading — качается, installed — стоит,
/// failed — скачивание сорвалось. Downloaded и Total — байты: ход скачивания или размер стоящего модуля;
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
/// Модуль голосового ввода — по желанию оператора (B-291): панель ставится и обновляется без него, а оператор
/// скачивает его кнопкой в «Настройках». Модуль — две части: модель распознавания и рантайм Whisper для
/// видеокарты. На процессоре фраза распознаётся секунды, на видеокарте — доли секунды — решение оператора на
/// приёмке B-291; рантайм весит десятки мегабайт, и в сборке панели ему не место. Без подходящей видеокарты
/// распознаёт процессор — его рантайм в сборке.
/// Модуль лежит не в каталоге панели, а рядом с ним: постановка подменяет каталог панели целиком и снесла бы его
/// с каждым обновлением. Каждая часть качается во временный файл и встаёт только целой: срыв и отмена не
/// оставляют полумодуля, который распознавание приняло бы за стоящий.
/// </summary>
public sealed class VoiceModel
{
    private readonly string _directory;
    private readonly Uri _source;
    private readonly Uri _runtimeSource;
    private readonly string _runtimeSha512;
    private readonly IHttpClientFactory _clients;

    /// <summary>
    /// Недокачанное прошлой панелью — её погасили посреди скачивания, обновили или перезагрузили машину — сотни
    /// мегабайт, которых «Удалить» не видно: новая панель убирает их сразу (ревью B-291). Скачивания в ней ещё нет.
    /// Рантайм убранного модуля, который прошлая панель держала загруженным и удалить не дала, уходит тоже.
    /// </summary>
    public VoiceModel(string directory, Uri source, Uri runtimeSource, string runtimeSha512, IHttpClientFactory clients)
    {
        _directory = directory;
        _source = source;
        _runtimeSource = runtimeSource;
        _runtimeSha512 = runtimeSha512;
        _clients = clients;
        DeletePart(PartFile);
        DeletePart(RuntimePartFile);
        try
        {
            if (Directory.Exists(Path.Combine(directory, "runtime.part")))
                Directory.Delete(Path.Combine(directory, "runtime.part"), recursive: true);
        }
        catch (IOException)
        {
            // Держит антивирус: перезапишет следующее скачивание.
        }
        if (!System.IO.File.Exists(File))
            DeleteRuntime();
    }

    public const string Client = "voice-model";
    public const string FileName = "ggml-large-v3-turbo-q5_0.bin";

    /// <summary>Хранилище авторов whisper.cpp: оттуда модель и берётся, копии у панели нет.</summary>
    public static readonly Uri DefaultSource =
        new("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + FileName);

    /// <summary>
    /// Версия рантайма Whisper для видеокарты — та же, что у Whisper.net в сборке панели (AgentsKitWeb.Api.csproj):
    /// рантайм другой версии обёртка не загрузит и молча уйдёт на процессор. Сходство держит тест; поднят
    /// Whisper.net — поднимаются версия и хеш здесь, и стоящий рантайм прежней версии докачивается заново.
    /// </summary>
    public const string RuntimeVersion = "1.9.1";

    /// <summary>Рантайм — пакет авторов Whisper.net в NuGet.</summary>
    public static readonly Uri DefaultRuntimeSource = new(
        $"https://api.nuget.org/v3-flatcontainer/whisper.net.runtime.vulkan/{RuntimeVersion}/whisper.net.runtime.vulkan.{RuntimeVersion}.nupkg");

    /// <summary>
    /// SHA-512 пакета этой версии, как его отдаёт nuget.org: библиотеки из пакета грузятся в процесс панели, и
    /// подменённый или испорченный по дороге пакет не встаёт.
    /// </summary>
    public const string DefaultRuntimeSha512 =
        "hRYbrj76y09g38wZccGb3DvNiempYMq6Zf6FX/gKzxjS2Ff1JeTZ/XSSuJ0UgU13q/TAsD/Gl/Ctu0PmNcFjdA==";

    private const string RuntimeEntries = "build/win-x64/";

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

    public string File => Path.Combine(_directory, FileName);

    /// <summary>
    /// Путь для RuntimeOptions.LibraryPath: загрузчик Whisper.net берёт от него каталог и ищет рядом
    /// runtimes/vulkan/win-x64 — там и лежит рантайм модуля. Самого файла нет.
    /// </summary>
    public string LibraryPath => Path.Combine(_directory, "whisper.dll");

    public string RuntimeDirectory => Path.Combine(_directory, "runtimes", "vulkan", "win-x64");

    private string PartFile => File + ".part";

    private string RuntimePartFile => Path.Combine(_directory, "runtime.nupkg.part");

    /// <summary>Отметка версии рядом с библиотеками: рантайм прежней версии стоящим не считается.</summary>
    private string RuntimeVersionFile => Path.Combine(RuntimeDirectory, "version.txt");

    private bool RuntimeInstalled
    {
        get
        {
            try
            {
                return System.IO.File.Exists(Path.Combine(RuntimeDirectory, "whisper.dll"))
                       && System.IO.File.ReadAllText(RuntimeVersionFile).Trim() == RuntimeVersion;
            }
            catch (IOException)
            {
                return false;
            }
        }
    }

    public bool Installed => System.IO.File.Exists(File) && RuntimeInstalled;

    /// <summary>Модуль стоит и его убирают: распознавание отпускает модель до удаления.</summary>
    public event Action? Removing;

    public VoiceState Read()
    {
        lock (_lock)
        {
            if (_download is not null)
                return new VoiceState(VoiceState.Downloading, _downloaded, _total, null);
            if (Installed)
            {
                var size = new FileInfo(File).Length
                           + Directory.EnumerateFiles(RuntimeDirectory).Sum(file => new FileInfo(file).Length);
                return new VoiceState(VoiceState.Installed, size, size, null);
            }
            // У сорвавшегося — сколько успело скачаться: карточка говорит, на чём прервалось.
            return _error is null
                ? new VoiceState(VoiceState.Absent, 0, null, null)
                : new VoiceState(VoiceState.Failed, _downloaded, _total, _error);
        }
    }

    /// <summary>
    /// Уже качается или уже стоит — false: второе скачивание тех же файлов не начинается. Качается только
    /// недостающее: модель, поставленная без рантайма, второй раз не тянет сотни мегабайт.
    /// </summary>
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

    /// <summary>
    /// Пока модуль качается, его не удалить: сперва отменить. Рантайм, загруженный распознаванием, Windows удалить
    /// не даёт до конца процесса панели — он уходит при её следующем запуске, а модуль числится убранным сразу.
    /// </summary>
    public bool Remove()
    {
        lock (_lock)
        {
            if (_download is not null)
                return false;
            _error = null;
        }
        Removing?.Invoke();
        if (System.IO.File.Exists(File))
            System.IO.File.Delete(File);
        DeleteRuntime();
        return true;
    }

    private async Task DownloadAsync(CancellationTokenSource download)
    {
        try
        {
            Directory.CreateDirectory(_directory);
            using var client = _clients.CreateClient(Client);
            var needRuntime = !RuntimeInstalled;
            var needModel = !System.IO.File.Exists(File);

            // Модель — первой, рантайм — последним: соседняя панель на том же каталоге, стартуя, убирает рантайм
            // без модели и стёрла бы свежий, пока минутами качается модель (ревью B-291). Размер рантайма
            // спрашивается сразу: ход считается от всего модуля.
            using var model = needModel
                ? await client.GetAsync(_source, HttpCompletionOption.ResponseHeadersRead, download.Token)
                : null;
            model?.EnsureSuccessStatusCode();
            long? runtimeSize = null;
            if (needRuntime)
            {
                using var head = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, _runtimeSource), download.Token);
                head.EnsureSuccessStatusCode();
                runtimeSize = head.Content.Headers.ContentLength;
            }
            lock (_lock)
                _total = (model is null ? 0 : model.Content.Headers.ContentLength) + (needRuntime ? runtimeSize : 0);

            if (model is not null)
            {
                await StreamAsync(model, PartFile, download);
                System.IO.File.Move(PartFile, File, overwrite: true);
            }
            if (needRuntime)
            {
                using var runtime = await client.GetAsync(_runtimeSource, HttpCompletionOption.ResponseHeadersRead, download.Token);
                runtime.EnsureSuccessStatusCode();
                await StreamAsync(runtime, RuntimePartFile, download);
                CheckRuntimeHash();
                ExtractRuntime();
            }
        }
        catch (Exception exception)
        {
            DeletePart(PartFile);
            if (!download.IsCancellationRequested)
                lock (_lock)
                    _error = Reason(exception);
        }
        finally
        {
            DeletePart(RuntimePartFile);
            lock (_lock)
                _download = null;
            download.Dispose();
        }
    }

    /// <summary>Тело ответа — в файл, порциями со сроком на каждую; счёт скачанного растёт по ходу.</summary>
    private async Task StreamAsync(HttpResponseMessage response, string path, CancellationTokenSource download)
    {
        var expected = response.Content.Headers.ContentLength;
        long written = 0;
        await using (var input = await response.Content.ReadAsStreamAsync(download.Token))
        await using (var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
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
                    throw new TimeoutException("Сервер перестал отдавать файлы модуля.");
                }
                if (read == 0)
                    break;
                await output.WriteAsync(buffer.AsMemory(0, read), download.Token);
                written += read;
                lock (_lock)
                    _downloaded += read;
            }
        }
        if (expected is { } total && written != total)
            throw new IncompleteDownload("Сервер отдал файлы модуля не целиком.");
    }

    private void CheckRuntimeHash()
    {
        using var package = System.IO.File.OpenRead(RuntimePartFile);
        if (Convert.ToBase64String(System.Security.Cryptography.SHA512.HashData(package)) != _runtimeSha512)
            throw new IncompleteDownload("Пакет рантайма не совпал с опубликованным.");
    }

    /// <summary>Из пакета берутся только библиотеки Windows x64; каталог рантайма встаёт целым или не встаёт.</summary>
    private void ExtractRuntime()
    {
        // Распаковка — рядом с моделью, вне runtimes: каталог прежнего рантайма убирается целиком перед переносом.
        var part = Path.Combine(_directory, "runtime.part");
        if (Directory.Exists(part))
            Directory.Delete(part, recursive: true);
        Directory.CreateDirectory(part);
        using (var package = ZipFile.OpenRead(RuntimePartFile))
        {
            var libraries = package.Entries
                .Where(entry => entry.FullName.StartsWith(RuntimeEntries, StringComparison.Ordinal)
                                && entry.Name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (!libraries.Any(entry => entry.Name.Equals("whisper.dll", StringComparison.OrdinalIgnoreCase)))
                throw new IncompleteDownload("В пакете рантайма нет библиотек для Windows.");
            foreach (var library in libraries)
                library.ExtractToFile(Path.Combine(part, library.Name), overwrite: true);
            System.IO.File.WriteAllText(Path.Combine(part, "version.txt"), RuntimeVersion);
        }
        DeleteRuntime();
        Directory.CreateDirectory(Path.GetDirectoryName(RuntimeDirectory)!);
        Directory.Move(part, RuntimeDirectory);
    }

    /// <summary>Причина словами оператору: сообщения HttpClient и сокетов приходят по-английски.</summary>
    private static string Reason(Exception exception) => exception switch
    {
        HttpRequestException { StatusCode: { } status } => $"Сервер модуля ответил {(int)status}.",
        TimeoutException or IncompleteDownload => exception.Message,
        InvalidDataException => "Пакет рантайма пришёл испорченным.",
        _ => "Связь с сервером модуля прервалась.",
    };

    private sealed class IncompleteDownload(string message) : IOException(message);

    private static void DeletePart(string path)
    {
        try
        {
            if (System.IO.File.Exists(path))
                System.IO.File.Delete(path);
        }
        catch (IOException)
        {
            // Недокачанное держит антивирус: его перезапишет следующее скачивание.
        }
    }

    private void DeleteRuntime()
    {
        var runtimes = Path.Combine(_directory, "runtimes");
        try
        {
            if (Directory.Exists(runtimes))
                Directory.Delete(runtimes, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Библиотеки держит загрузивший их процесс панели: их уберёт её следующий запуск.
        }
    }
}
