using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Ask;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class AskEndpointsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    private readonly string _root = Directory.CreateTempSubdirectory("akw-ask-").FullName;
    private readonly string _base;
    private readonly TestChat _agent = new();

    public AskEndpointsTests()
    {
        _base = Path.Combine(_root, "app-knowledge");
        Directory.CreateDirectory(_base);
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), "{}");
        File.WriteAllText(Path.Combine(_base, "product.md"), "# Order Service — продукт\n");
    }

    [Fact]
    public async Task Bases_ReturnsBasesWithProjectNames()
    {
        var bases = await Client(_base).GetFromJsonAsync<List<AskBase>>("/api/ask/bases");

        Assert.Equal([new AskBase(_base, "Order Service")], bases);
    }

    [Fact]
    public async Task Ask_PutsQuestionStepsAndAnswerIntoConversation()
    {
        var file = Path.Combine(_base, "decisions", "ui.md");
        _agent.Answers =
        [
            [
                """{"type":"system","subtype":"init","tools":["Read"]}""",
                Tool("Grep", new { pattern = "опрос", path = Path.Combine(_base, "decisions") }),
                Tool("Read", new { file_path = file }),
                """{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}""",
                """{"type":"result","subtype":"success","is_error":false,"duration_ms":8335,"result":"Так решил оператор."}""",
            ],
        ];
        var client = Client(_base);

        await Ask(client, _base, "Почему опрос?");
        var events = await Read(client, 4);

        Assert.Equal(
            [
                new AskEvent("reply", "Почему опрос?"),
                new AskEvent("step", "ищет «опрос» в decisions"),
                new AskEvent("step", "читает decisions/ui.md"),
            ],
            events.Take(3));
        var answer = events[3];
        Assert.Equal("answer", answer.Type);
        Assert.Equal("Так решил оператор.", answer.Text);
        Assert.Equal(["decisions/ui.md"], answer.Files);
        Assert.Equal(8335, answer.DurationMs);
    }

    [Fact]
    public async Task Ask_RunsReadOnlyClaudeInBaseWithReplyOnStdin()
    {
        _agent.Answers = [[Result("ok")]];

        var client = Client(_base);
        await Ask(client, _base, "--help и ещё вопрос");
        await Read(client, 2);

        var startInfo = Assert.Single(_agent.Starts);
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_base, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.False(startInfo.UseShellExecute);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("stream-json", args[args.IndexOf("--input-format") + 1]);
        Assert.Contains("--no-session-persistence", args);
        // Копия не выбрана — разговор идёт по одной базе.
        Assert.DoesNotContain("--add-dir", args);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        Assert.DoesNotContain(args, a => a.Contains("dangerously", StringComparison.OrdinalIgnoreCase));
        // Флоу базы лежит в форме кита — сценарии и этапы по файлу: так агенту и сказано, где его читать.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains("flow/scenarios.md", prompt);
        Assert.Contains("flow/stages/*.md", prompt);
        var sent = Assert.Single(_agent.Input);
        Assert.Contains("--help и ещё вопрос", sent);
        Assert.Equal("user", JsonDocument.Parse(sent).RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Copies_ReturnsCopiesOfBaseOnDiskWithMainFirst()
    {
        // Копия задачи по имени идёт раньше основной: порядок «основная первой» ставит API, а не обход каталогов.
        var main = WithCopies("app", "aaa-task");

        var copies = await Client(_base).GetFromJsonAsync<List<CopyJson>>($"/api/ask/copies?base={Uri.EscapeDataString(_base)}");

        Assert.NotNull(copies);
        Assert.Equal(2, copies.Count);
        Assert.Equal(new CopyJson(main[0], "app", "dev", true), copies[0]);
        Assert.Equal(new CopyJson(main[1], "aaa-task", "dev", false), copies[1]);
    }

    [Fact]
    public async Task Copies_OfUnknownBaseIsNotFound()
    {
        var response = await Client(_base).GetAsync($"/api/ask/copies?base={Uri.EscapeDataString(_root)}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Ask_WithCopyGivesItsCodeAsSecondReadOnlyDirectory()
    {
        var copy = WithCopies("app", "app-task")[1];
        _agent.Answers =
        [
            [
                // Путь через «/»: агент называет файлы и так.
                Tool("Read", new { file_path = Path.Combine(copy, "src", "Program.cs").Replace('\\', '/') }),
                Tool("Read", new { file_path = Path.Combine(_base, "product.md") }),
                Result("По коду."),
            ],
        ];
        var client = Client(_base);

        await Ask(client, _base, "Что делает Program?", copy);
        var events = await Read(client, 4);

        var startInfo = Assert.Single(_agent.Starts);
        // Агент остаётся в базе, а код копии получает вторым каталогом — с тем же набором только для чтения.
        Assert.Equal(_base, startInfo.WorkingDirectory);
        var args = startInfo.ArgumentList.ToList();
        Assert.Equal(copy, args[args.IndexOf("--add-dir") + 1]);
        Assert.Equal("Read,Grep,Glob", args[args.IndexOf("--tools") + 1]);
        Assert.Contains(copy, args[args.IndexOf("--append-system-prompt") + 1]);
        // Файлы копии видны путём от копии, вперемешку с файлами базы.
        Assert.Equal(new AskEvent("step", "читает src/Program.cs"), events[1]);
        Assert.Equal(["src/Program.cs", "product.md"], events[3].Files);
        // Окно, открытое заново, узнаёт копию разговора по просьбе в списке панели.
        var listed = await client.GetFromJsonAsync<List<AgentRequestSummary>>("/api/agent/requests", Json);
        Assert.Equal(copy, Assert.Single(listed!).Subject);
    }

    [Fact]
    public async Task Ask_WithDirectoryThatIsNotCopyOfBaseIsNotFound()
    {
        WithCopies("app");
        var foreign = Directory.CreateDirectory(Path.Combine(_root, "elsewhere")).FullName;

        using var response = await Client(_base).SendAsync(Post(_base, "Вопрос", foreign));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Reply_RaisesNewAgentWithSameCopy()
    {
        var copy = WithCopies("app", "app-task")[1];
        _agent.Answers = [[Result("Первый ответ")], [Result("Второй ответ")]];
        _agent.StopAfter = 1;
        var client = Client(_base);

        await Ask(client, _base, "Первый вопрос", copy);
        await Read(client, 2);
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "Второй вопрос")).StatusCode);
        await Read(client, 5);

        Assert.Equal(2, _agent.Starts.Count);
        Assert.All(_agent.Starts, start =>
        {
            var args = start.ArgumentList.ToList();
            Assert.Equal(copy, args[args.IndexOf("--add-dir") + 1]);
        });
    }

    [Fact]
    public async Task Reply_ContinuesSameConversationInSameProcess()
    {
        _agent.Answers = [[Result("Первый ответ")], [Result("Второй ответ")]];
        var client = Client(_base);

        await Ask(client, _base, "Первый вопрос");
        await Read(client, 2);
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "Второй вопрос")).StatusCode);
        var events = await Read(client, 4);

        Assert.Equal(
            [
                ("reply", "Первый вопрос"),
                ("answer", "Первый ответ"),
                ("reply", "Второй вопрос"),
                ("answer", "Второй ответ"),
            ],
            events.Select(e => (e.Type, e.Text)));
        // Тот же процесс на обе реплики: в нём и живёт память разговора.
        Assert.Single(_agent.Starts);
        Assert.Equal(2, _agent.Input.Count);
    }

    [Fact]
    public async Task Reply_IsRefusedWhileAgentIsAnswering()
    {
        var release = new TaskCompletionSource();
        _agent.Answers = [[Result("Ответ")]];
        _agent.BeforeLine = _ => release.Task;
        var client = Client(_base);

        await Ask(client, _base, "Вопрос");

        Assert.Equal(HttpStatusCode.Conflict, (await Reply(client, "И ещё")).StatusCode);
        release.SetResult();
    }

    [Fact]
    public async Task Reply_WithoutConversationIsNotFound()
    {
        var client = Client(_base);

        Assert.Equal(HttpStatusCode.NotFound, (await Reply(client, "Вопрос")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Reply(client, "  ")).StatusCode);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Reply_RaisesNewAgentWhenProcessIsGoneAndSaysHeForgot()
    {
        _agent.Answers = [[Result("Первый ответ")], [Result("Второй ответ")]];
        // Процесс кончился сам, ответив на первую реплику: продолжать нечем.
        _agent.StopAfter = 1;
        var client = Client(_base);

        await Ask(client, _base, "Первый вопрос");
        await Read(client, 2);
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "Второй вопрос")).StatusCode);
        var events = await Read(client, 5);

        Assert.Equal("note", events[2].Type);
        Assert.Contains("не помнит", events[2].Text);
        Assert.Equal(("reply", "Второй вопрос"), (events[3].Type, events[3].Text));
        Assert.Equal(("answer", "Второй ответ"), (events[4].Type, events[4].Text));
        Assert.Equal(2, _agent.Starts.Count);
    }

    [Fact]
    public async Task Stop_EndsCurrentAnswerAndKeepsConversation()
    {
        var release = new TaskCompletionSource();
        var answering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _agent.Answers = [[Result("Ответ")], [Result("Второй ответ")]];
        _agent.BeforeLine = _ =>
        {
            answering.TrySetResult();
            return release.Task;
        };
        var client = Client(_base);

        await Ask(client, _base, "Долгий вопрос");
        // Обрывается ответ, который уже идёт: остановленный раньше, чем агент взял вопрос, вопроса и не увидит,
        // и заглушка ответила бы на следующую реплику первым ответом.
        await answering.Task.WaitAsync(Wait);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/ask/stop", null)).StatusCode);
        var stopped = await Read(client, 2);

        Assert.Equal("stopped", stopped[1].Type);
        Assert.True(await _agent.CancelledWithin(Wait));
        release.SetResult();

        // Переписка осталась, и разговор продолжается новым агентом.
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "Второй вопрос")).StatusCode);
        var events = await Read(client, 5);
        Assert.Equal("reply", events[0].Type);
        Assert.Equal("note", events[2].Type);
        Assert.Equal(("answer", "Второй ответ"), (events[4].Type, events[4].Text));
    }

    [Fact]
    public async Task Ask_StreamsEachLineAsAgentWritesIt()
    {
        var release = new TaskCompletionSource();
        _agent.Answers =
        [
            [Tool("Read", new { file_path = Path.Combine(_base, "product.md") }), Result("ok")],
        ];
        _agent.BeforeLine = index => index == 1 ? release.Task : Task.CompletedTask;

        var client = Client(_base);
        await Ask(client, _base, "Что за проект?");
        using var response = await client.GetAsync(
            "/api/agent/ask/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());

        Assert.Equal("reply", (await Line(reader)).Type);
        Assert.Equal(new AskEvent("step", "читает product.md"), await Line(reader));

        release.SetResult();
        Assert.Equal("answer", (await Line(reader)).Type);
    }

    [Fact]
    public async Task Ask_ReportsAgentErrorResultWithItsText()
    {
        _agent.Answers =
        [
            ["""{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"""],
        ];
        var client = Client(_base);

        await Ask(client, _base, "Вопрос");
        var events = await Read(client, 2);

        Assert.Equal("error", events[1].Type);
        Assert.Equal("Invalid API key · Please run /login", events[1].Output);
    }

    [Fact]
    public async Task Ask_ReportsExitWithoutResultWithStderrAndStdout()
    {
        _agent.Answers = [["не JSON"]];
        _agent.StopAfter = 1;
        _agent.Exit = new AgentExit(2, "что-то сломалось");
        var client = Client(_base);

        await Ask(client, _base, "Вопрос");
        var events = await Read(client, 2);

        Assert.Equal("error", events[1].Type);
        Assert.Equal("что-то сломалось\nне JSON", events[1].Output);
    }

    [Fact]
    public async Task Ask_ReportsAgentThatDidNotStart()
    {
        _agent.StopAfter = 0;
        _agent.Exit = new AgentExit(null, "Не удаётся найти указанный файл");
        var client = Client(_base);

        await Ask(client, _base, "Вопрос");
        var events = await Read(client, 2);

        Assert.Equal("Claude Code не запустился", events[1].Text);
        Assert.Equal("Не удаётся найти указанный файл", events[1].Output);
    }

    [Fact]
    public async Task Ask_RejectsBaseOutsideListAndEmptyQuestion()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client(_base);

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Вопрос"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task AgentChat_AnswersEveryReplyFromOneLiveProcess()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("while ($line = [Console]::In.ReadLine()) { Write-Output \"$PID+$line\" }");
        var replies = Channel.CreateUnbounded<string>();
        var lines = Channel.CreateUnbounded<string>();

        var run = new AgentChat().RunAsync(
            startInfo, replies.Reader, line => { lines.Writer.TryWrite(line); return Task.CompletedTask; }, CancellationToken.None);
        replies.Writer.TryWrite("раз");
        var first = await lines.Reader.ReadAsync().AsTask().WaitAsync(Wait);
        replies.Writer.TryWrite("два");
        var second = await lines.Reader.ReadAsync().AsTask().WaitAsync(Wait);
        replies.Writer.Complete();
        var exit = await run.WaitAsync(Wait);

        Assert.EndsWith("+раз", first);
        Assert.EndsWith("+два", second);
        // Обе реплики прочитал один процесс: между ними он не перезапускался.
        Assert.Equal(first.Split('+')[0], second.Split('+')[0]);
        Assert.Equal(0, exit.ExitCode);
    }

    [Fact]
    public async Task AgentChat_CancellationKillsProcess()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("Write-Output $PID; Start-Sleep -Seconds 60");
        using var cancel = new CancellationTokenSource();
        var replies = Channel.CreateUnbounded<string>();
        var pid = 0;

        var run = new AgentChat().RunAsync(startInfo, replies.Reader, line =>
        {
            pid = int.Parse(line);
            cancel.Cancel();
            return Task.CompletedTask;
        }, cancel.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public async Task AgentProcess_PassesStdinAndReturnsExitCodeAndStderr()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("$q = [Console]::In.ReadToEnd(); Write-Output \"got:$q\"; [Console]::Error.Write('oops'); exit 3");
        var lines = new List<string>();

        var exit = await new AgentProcess().RunAsync(startInfo, "вопрос", line =>
        {
            lines.Add(line);
            return Task.CompletedTask;
        }, CancellationToken.None);

        Assert.Equal(["got:вопрос"], lines);
        Assert.Equal(new AgentExit(3, "oops"), exit);
    }

    [Fact]
    public async Task AgentProcess_CancellationKillsProcess()
    {
        var startInfo = AgentProcess.StartInfo("pwsh", _root);
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-Command");
        startInfo.ArgumentList.Add("Write-Output $PID; Start-Sleep -Seconds 60");
        using var cancel = new CancellationTokenSource();
        var pid = 0;

        var run = new AgentProcess().RunAsync(startInfo, "", line =>
        {
            pid = int.Parse(line);
            cancel.Cancel();
            return Task.CompletedTask;
        }, cancel.Token);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public async Task AgentProcess_ReportsMissingProgram()
    {
        var exit = await new AgentProcess().RunAsync(
            AgentProcess.StartInfo("akw-no-such-program", _root), "", _ => Task.CompletedTask, CancellationToken.None);

        Assert.Null(exit.ExitCode);
        Assert.NotEmpty(exit.Error);
    }

    public void Dispose()
    {
        try
        {
            // Объекты git лежат read-only: без снятия атрибутов каталог прогона не удаляется.
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Копии проекта на диске; первая в agents-kit.json — основная.</summary>
    private string[] WithCopies(params string[] names)
    {
        var copies = names.Select(name => TestGit.Repository(Path.Combine(_root, name))).ToArray();
        File.WriteAllText(
            Path.Combine(_base, "agents-kit.json"),
            JsonSerializer.Serialize(new { kit = "agents-kit", version = 1, workspaces = copies }));
        return copies;
    }

    private sealed record CopyJson(string Path, string Name, string? Branch, bool Main);

    private static string Tool(string name, object input) => JsonSerializer.Serialize(new
    {
        type = "assistant",
        message = new { content = new object[] { new { type = "tool_use", name, input } } },
    });

    private static string Result(string text) => JsonSerializer.Serialize(new
    {
        type = "result",
        subtype = "success",
        is_error = false,
        result = text,
    });

    private static HttpRequestMessage Post(string basePath, string question, string? copy = null) =>
        new(HttpMethod.Post, "/api/ask") { Content = JsonContent.Create(new AskRequest(basePath, question, copy)) };

    private static async Task Ask(HttpClient client, string basePath, string question, string? copy = null)
    {
        using var started = await client.SendAsync(Post(basePath, question, copy));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
    }

    private static Task<HttpResponseMessage> Reply(HttpClient client, string text) =>
        client.PostAsJsonAsync("/api/ask/reply", new AskReply(text));

    /// <summary>Как окно: переписка читается потоком просьбы с начала и ждёт следующих событий в нём же.</summary>
    private static async Task<List<AskEvent>> Read(HttpClient client, int count)
    {
        using var response = await client.GetAsync(
            "/api/agent/ask/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var events = new List<AskEvent>();
        while (events.Count < count)
            events.Add(await Line(reader));
        return events;
    }

    private static async Task<AskEvent> Line(StreamReader reader)
    {
        while (true)
        {
            var line = await reader.ReadLineAsync().WaitAsync(Wait);
            Assert.NotNull(line);
            if (line.Trim().Length > 0)
                return JsonSerializer.Deserialize<AskEvent>(line, Json)!;
        }
    }

    private HttpClient Client(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и читает вывод.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentChat>();
                services.AddSingleton<IAgentChat>(_agent);
            });
        }).CreateClient();
}
