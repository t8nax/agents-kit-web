using Whisper.net;

namespace AgentsKitWeb.Api.Voice;

/// <summary>Кусок речи — моно 16 кГц, отсчёты от -1 до 1 — в текст.</summary>
public interface ISpeechRecognizer
{
    Task<string> RecognizeAsync(float[] samples, CancellationToken cancellationToken);
}

/// <summary>
/// Распознавание на машине оператора программой Whisper: звук не уходит из панели — решение оператора на B-291.
/// Модель грузится при первом куске и держится в памяти: грузить сотни мегабайт на каждый кусок
/// значило бы ждать секунды там, где оператор ждёт текста. Куски распознаются по одному — процессор
/// Whisper не терпит двух разом, а у оператора один голос.
/// </summary>
public sealed class WhisperRecognizer : ISpeechRecognizer, IDisposable
{
    private readonly VoiceModel _model;
    private readonly SemaphoreSlim _turn = new(1, 1);
    private WhisperFactory? _factory;

    public WhisperRecognizer(VoiceModel model)
    {
        _model = model;
        // Модель убирают из «Настроек» — распознавание отпускает её, иначе файл не удалить.
        model.Removing += Unload;
    }

    public async Task<string> RecognizeAsync(float[] samples, CancellationToken cancellationToken)
    {
        await _turn.WaitAsync(cancellationToken);
        try
        {
            _factory ??= WhisperFactory.FromPath(_model.File);
            await using var processor = _factory.CreateBuilder()
                .WithLanguage("ru")
                // Панель делит машину с сессиями агентов: распознаванию — половина ядер.
                .WithThreads(Math.Max(1, Environment.ProcessorCount / 2))
                .Build();
            var text = new List<string>();
            await foreach (var segment in processor.ProcessAsync(samples, cancellationToken))
                text.Add(segment.Text.Trim());
            return string.Join(' ', text.Where(part => part.Length > 0));
        }
        finally
        {
            _turn.Release();
        }
    }

    private void Unload()
    {
        _turn.Wait();
        try
        {
            _factory?.Dispose();
            _factory = null;
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
