using Whisper.net;
using Whisper.net.LibraryLoader;

namespace AgentsKitWeb.Api.Voice;

/// <summary>Кусок речи — моно 16 кГц, отсчёты от -1 до 1 — в текст.</summary>
public interface ISpeechRecognizer
{
    Task<string> RecognizeAsync(float[] samples, CancellationToken cancellationToken);

    /// <summary>Загрузить модель и прогнать её вхолостую, чтобы первая фраза оператора не ждала прогрева.</summary>
    Task WarmAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Распознавание на машине оператора программой Whisper: звук не уходит из панели — решение оператора на B-291.
/// Сначала видеокартой — её рантайм приходит с модулем, фраза за доли секунды; нет подходящей — процессором.
/// Модель грузится один раз и держится в памяти; куски распознаются по одному — процессор Whisper не терпит двух
/// разом, а у оператора один голос.
/// </summary>
public sealed class WhisperRecognizer : ISpeechRecognizer, IDisposable
{
    private readonly VoiceModel _model;
    private readonly SemaphoreSlim _turn = new(1, 1);
    private WhisperFactory? _factory;
    private bool _warm;

    public WhisperRecognizer(VoiceModel model)
    {
        _model = model;
        // Порядок и место рантаймов читаются при первой загрузке и больше не меняются: задаются до неё.
        RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu];
        RuntimeOptions.LibraryPath = model.LibraryPath;
        // Модель убирают из «Настроек» — распознавание отпускает её, иначе файл не удалить.
        model.Removing += Unload;
    }

    public async Task<string> RecognizeAsync(float[] samples, CancellationToken cancellationToken)
    {
        await _turn.WaitAsync(cancellationToken);
        try
        {
            return await ProcessAsync(samples, cancellationToken);
        }
        finally
        {
            _turn.Release();
        }
    }

    /// <summary>
    /// Видеокарта перед первой фразой собирает свои программы — секунд пятнадцать; панель платит их заранее,
    /// когда в окнах появилась кнопка микрофона, а не когда оператор уже говорит.
    /// </summary>
    public async Task WarmAsync(CancellationToken cancellationToken)
    {
        await _turn.WaitAsync(cancellationToken);
        try
        {
            if (_warm)
                return;
            await ProcessAsync(new float[VoiceEndpoints.SampleRate], cancellationToken);
            _warm = true;
        }
        finally
        {
            _turn.Release();
        }
    }

    private async Task<string> ProcessAsync(float[] samples, CancellationToken cancellationToken)
    {
        _factory ??= WhisperFactory.FromPath(_model.File, new WhisperFactoryOptions { UseFlashAttention = true });
        await using var processor = _factory.CreateBuilder()
            .WithLanguage("ru")
            // Каждый кусок сам по себе: прошлый текст подсказкой Whisper толкает к повторам.
            .WithNoContext()
            // Процессору, если видеокарты нет, — половина ядер: панель делит машину с сессиями агентов.
            .WithThreads(Math.Max(1, Environment.ProcessorCount / 2))
            .Build();
        var text = new List<string>();
        await foreach (var segment in processor.ProcessAsync(samples, cancellationToken))
            text.Add(segment.Text.Trim());
        return string.Join(' ', text.Where(part => part.Length > 0));
    }

    private void Unload()
    {
        _turn.Wait();
        try
        {
            _factory?.Dispose();
            _factory = null;
            _warm = false;
        }
        finally
        {
            _turn.Release();
        }
    }

    public void Dispose()
    {
        _model.Removing -= Unload;
        _factory?.Dispose();
        _turn.Dispose();
    }
}
