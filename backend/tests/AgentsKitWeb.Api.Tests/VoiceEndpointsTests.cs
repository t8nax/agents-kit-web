using System.Net;
using System.Net.Http.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Voice;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class VoiceEndpointsTests : IDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-voice-").FullName;
    private readonly TestHosts _hosts = new();
    private readonly ModelServer _server = new();
    private readonly Recognizer _recognizer = new();

    private string VoiceDir => Path.Combine(_root, "voice");

    [Fact]
    public async Task Voice_WithoutModel_IsAbsent()
    {
        var client = Factory().CreateClient();

        var state = await client.GetFromJsonAsync<VoiceState>("/api/voice");

        Assert.Equal(VoiceState.Absent, state?.State);
    }

    [Fact]
    public async Task Install_DownloadsModelBesideThePanel()
    {
        _server.Answer(total: 6, "abc", "def");
        var client = Factory().CreateClient();

        var response = await client.PostAsync("/api/voice/install", null);
        var state = await WaitAsync(client, VoiceState.Installed);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(6, state.Downloaded);
        Assert.Equal("abcdef", File.ReadAllText(Path.Combine(VoiceDir, VoiceModel.FileName)));
        Assert.Equal([VoiceModel.FileName], Directory.GetFiles(VoiceDir).Select(Path.GetFileName));
    }

    [Fact]
    public async Task Install_WhileDownloading_ShowsProgressInBytes()
    {
        var portions = _server.Hold(total: 10);
        var client = Factory().CreateClient();
        await client.PostAsync("/api/voice/install", null);

        await portions.Writer.WriteAsync("abcd"u8.ToArray());
        var state = await WaitAsync(client, VoiceState.Downloading, s => s.Downloaded == 4);

        Assert.Equal(10, state.Total);
        var again = await client.PostAsync("/api/voice/install", null);
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        portions.Writer.Complete(new IOException("оборвалось"));
    }

    [Fact]
    public async Task Cancel_LeavesNeitherModelNorPart()
    {
        var portions = _server.Hold(total: 10);
        var client = Factory().CreateClient();
        await client.PostAsync("/api/voice/install", null);
        await portions.Writer.WriteAsync("abcd"u8.ToArray());
        await WaitAsync(client, VoiceState.Downloading, s => s.Downloaded == 4);

        await client.PostAsync("/api/voice/cancel", null);
        var state = await WaitAsync(client, VoiceState.Absent);

        Assert.Null(state.Error);
        Assert.Empty(Directory.GetFiles(VoiceDir));
    }

    [Fact]
    public async Task Download_BrokenMidway_FailsAndCanBeRetried()
    {
        var portions = _server.Hold(total: 10);
        var client = Factory().CreateClient();
        await client.PostAsync("/api/voice/install", null);
        await portions.Writer.WriteAsync("abcd"u8.ToArray());
        await WaitAsync(client, VoiceState.Downloading, s => s.Downloaded == 4);

        portions.Writer.Complete(new IOException("связь оборвалась"));
        var failed = await WaitAsync(client, VoiceState.Failed);

        // Карточка говорит, на чём прервалось, — словами, а не английским текстом исключения.
        Assert.Equal("Связь с сервером модели прервалась.", failed.Error);
        Assert.Equal((4, 10), (failed.Downloaded, failed.Total));
        Assert.Empty(Directory.GetFiles(VoiceDir));
        _server.Answer(total: 3, "abc");
        await client.PostAsync("/api/voice/install", null);
        await WaitAsync(client, VoiceState.Installed);
    }

    [Fact]
    public async Task Download_ShorterThanAnnounced_Fails()
    {
        _server.Answer(total: 10, "abc");
        var client = Factory().CreateClient();

        await client.PostAsync("/api/voice/install", null);
        await WaitAsync(client, VoiceState.Failed);

        Assert.Empty(Directory.GetFiles(VoiceDir));
    }

    [Fact]
    public async Task Download_RefusedByServer_Fails()
    {
        _server.Refuse(HttpStatusCode.NotFound);
        var client = Factory().CreateClient();

        await client.PostAsync("/api/voice/install", null);
        var state = await WaitAsync(client, VoiceState.Failed);

        Assert.Equal("Сервер модели ответил 404.", state.Error);
    }

    [Fact]
    public async Task Remove_Installed_LeavesNoModel()
    {
        Directory.CreateDirectory(VoiceDir);
        File.WriteAllText(Path.Combine(VoiceDir, VoiceModel.FileName), "модель");
        var client = Factory().CreateClient();
        Assert.Equal(VoiceState.Installed, (await client.GetFromJsonAsync<VoiceState>("/api/voice"))?.State);

        var install = await client.PostAsync("/api/voice/install", null);
        var response = await client.DeleteAsync("/api/voice");

        Assert.Equal(HttpStatusCode.Conflict, install.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(VoiceState.Absent, (await client.GetFromJsonAsync<VoiceState>("/api/voice"))?.State);
        Assert.Empty(Directory.GetFiles(VoiceDir));
    }

    [Fact]
    public async Task Start_RemovesPartLeftByStoppedPanel()
    {
        // Прошлую панель погасили посреди скачивания: недокачанное осталось рядом с каталогом панели.
        Directory.CreateDirectory(VoiceDir);
        var part = Path.Combine(VoiceDir, VoiceModel.FileName + ".part");
        File.WriteAllText(part, "полмодели");
        var client = Factory().CreateClient();

        var state = await client.GetFromJsonAsync<VoiceState>("/api/voice");

        Assert.Equal(VoiceState.Absent, state?.State);
        Assert.False(File.Exists(part));
    }

    [Fact]
    public async Task Remove_WhileDownloading_IsRefused()
    {
        var portions = _server.Hold(total: 10);
        var client = Factory().CreateClient();
        await client.PostAsync("/api/voice/install", null);
        await portions.Writer.WriteAsync("ab"u8.ToArray());
        await WaitAsync(client, VoiceState.Downloading, s => s.Downloaded == 2);

        var response = await client.DeleteAsync("/api/voice");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        portions.Writer.Complete(new IOException("оборвалось"));
    }

    [Fact]
    public async Task Recognize_HandsSamplesToRecognizerAndAnswersText()
    {
        InstallModel();
        _recognizer.Answer = "Привет, агент.";
        var client = Factory().CreateClient();

        var response = await client.PostAsync("/api/voice/recognize", Samples(0.5f, -0.25f, 1f));
        var answer = await response.Content.ReadFromJsonAsync<VoiceTextResponse>();

        Assert.Equal("Привет, агент.", answer?.Text);
        Assert.Equal([0.5f, -0.25f, 1f], _recognizer.Heard!);
    }

    [Fact]
    public async Task Recognize_WithoutModel_IsConflict()
    {
        var client = Factory().CreateClient();

        var response = await client.PostAsync("/api/voice/recognize", Samples(0.5f));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Null(_recognizer.Heard);
    }

    [Fact]
    public async Task Recognize_LongerThanAChunk_IsRefused()
    {
        InstallModel();
        var client = Factory().CreateClient();

        var response = await client.PostAsync("/api/voice/recognize",
            Samples(new float[VoiceEndpoints.MaxSeconds * VoiceEndpoints.SampleRate + 1]));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Null(_recognizer.Heard);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    public async Task Recognize_NotWholeSamples_IsBadRequest(int bytes)
    {
        InstallModel();
        var client = Factory().CreateClient();

        var response = await client.PostAsync("/api/voice/recognize", new ByteArrayContent(new byte[bytes]));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public void Runtime_IsFoundBesideThePanel()
    {
        // Рантайм грузится до разбора модели: на негодном файле отказ — от разбора, а не «библиотека не найдена».
        var file = Path.Combine(_root, "not-a-model.bin");
        File.WriteAllText(file, "не модель");

        var failure = Record.Exception(() =>
        {
            using var factory = Whisper.net.WhisperFactory.FromPath(file);
            using var processor = factory.CreateBuilder().Build();
        });

        Assert.NotNull(failure);
        Assert.IsNotType<DllNotFoundException>(failure);
        Assert.DoesNotContain("library", failure.Message, StringComparison.OrdinalIgnoreCase);
    }

    private void InstallModel()
    {
        Directory.CreateDirectory(VoiceDir);
        File.WriteAllText(Path.Combine(VoiceDir, VoiceModel.FileName), "модель");
    }

    private static ByteArrayContent Samples(params float[] samples)
    {
        var bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return new ByteArrayContent(bytes);
    }

    private static async Task<VoiceState> WaitAsync(HttpClient client, string expected, Func<VoiceState, bool>? also = null)
    {
        var deadline = DateTime.UtcNow + Patience;
        while (true)
        {
            var state = await client.GetFromJsonAsync<VoiceState>("/api/voice");
            if (state?.State == expected && (also is null || also(state)))
                return state;
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException($"Модуль не пришёл в {expected}: {state}");
            await Task.Delay(20);
        }
    }

    private WebApplicationFactory<Program> Factory() =>
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection(
                [
                    new("BasesFile", TestBases.File(_root)),
                    new("VoiceDir", VoiceDir),
                    new("VoiceModelUrl", "https://models.test/" + VoiceModel.FileName),
                ]);
            });
            builder.ConfigureServices(services =>
            {
                services.AddHttpClient(VoiceModel.Client).ConfigurePrimaryHttpMessageHandler(() => _server);
                services.RemoveAll<ISpeechRecognizer>();
                services.AddSingleton<ISpeechRecognizer>(_recognizer);
            });
        }));

    public void Dispose()
    {
        _server.Release();
        _hosts.Dispose();
        TestDirs.Delete(_root);
    }

    /// <summary>
    /// Сервер модели: отдаёт ответ целиком, отказывает или держит его и отдаёт порциями, которые пишет тест, —
    /// так видны ход скачивания, отмена и обрыв посреди.
    /// </summary>
    private sealed class ModelServer : HttpMessageHandler
    {
        private Func<HttpResponseMessage> _answer = () => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
        private Channel<byte[]>? _held;

        public void Answer(long total, params string[] portions)
        {
            var body = string.Concat(portions);
            _answer = () =>
            {
                var content = new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes(body));
                content.Headers.ContentLength = total;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            };
        }

        public void Refuse(HttpStatusCode status) => _answer = () => new HttpResponseMessage(status);

        public Channel<byte[]> Hold(long total)
        {
            var portions = _held = Channel.CreateUnbounded<byte[]>();
            _answer = () =>
            {
                var content = new StreamContent(new PortionStream(portions.Reader));
                content.Headers.ContentLength = total;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            };
            return portions;
        }

        public void Release() => _held?.Writer.TryComplete(new IOException("тест кончился"));

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(_answer());
    }

    /// <summary>Распознавание без модели: запоминает, что услышало, и отвечает заданным текстом.</summary>
    private sealed class Recognizer : ISpeechRecognizer
    {
        public string Answer { get; set; } = "";
        public float[]? Heard { get; private set; }

        public Task<string> RecognizeAsync(float[] samples, CancellationToken cancellationToken)
        {
            Heard = samples;
            return Task.FromResult(Answer);
        }
    }

    private sealed class PortionStream(ChannelReader<byte[]> portions) : Stream
    {
        private byte[] _current = [];
        private int _offset;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_offset == _current.Length)
            {
                if (!await portions.WaitToReadAsync(cancellationToken))
                    return 0;
                _current = await portions.ReadAsync(cancellationToken);
                _offset = 0;
            }
            var count = Math.Min(buffer.Length, _current.Length - _offset);
            _current.AsMemory(_offset, count).CopyTo(buffer);
            _offset += count;
            return count;
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
