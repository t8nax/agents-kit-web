using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Workspaces;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentsKitWeb.Api.Tests;

public sealed class BacklogWriteEndpointsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    private const string Backlog = """
        # Order Service — бэклог

        следующий номер: B-3
        поля: тип, приоритет

        ## B-1 Старая запись
        тип: фича
        приоритет: средний

        Текст старой записи.

        ### Агенту
        - где: App.tsx

        ## B-2 Вторая запись

        Текст второй записи.
        """;

    private readonly string _root = Directory.CreateTempSubdirectory("akw-backlog-write-").FullName;
    private readonly string _base;
    private readonly string _copy;
    private readonly TestChat _agent = new();

    /// <summary>Команда коммита, которую панель диктует агенту и кладёт в правило разрешения.</summary>
    private string Commit => $"git -C \"{_base}\" commit -m \"{BacklogWriteEndpoints.CommitMessage}\" -- backlog.md";

    private string BacklogPath => Path.Combine(_base, "backlog.md");

    public BacklogWriteEndpointsTests()
    {
        _copy = Path.Combine(_root, "app");
        Directory.CreateDirectory(Path.Combine(_copy, "frontend", "src"));
        _base = TestGit.Repository(Path.Combine(_root, "app-knowledge"));
        TestGit.Run(_base, "config", "user.name", "t");
        TestGit.Run(_base, "config", "user.email", "t@t");
        TestGit.Run(_base, "config", "core.autocrlf", "false");
        File.WriteAllText(Path.Combine(_base, "agents-kit.json"), JsonSerializer.Serialize(new { workspaces = new[] { _copy } }));
        File.WriteAllText(BacklogPath, Backlog.ReplaceLineEndings("\n") + "\n");
        TestGit.Run(_base, "add", "agents-kit.json", "backlog.md");
        TestGit.Run(_base, "commit", "-m", "base");
    }

    [Fact]
    public async Task Write_StreamsStepsAndReportsNewCommittedEntries()
    {
        _agent.Answers =
        [
            [
                Tool("Read", new { file_path = @"C:\Users\op\.claude\skills\agents-kit\reference\backlog-record.md" }),
                Tool("Grep", new { pattern = "Waiting", path = Path.Combine(_copy, "frontend", "src") }),
                Tool("Edit", new { file_path = BacklogPath }),
                Tool("PowerShell", new { command = Commit }),
                Result("Записал B-3 и B-4.", 41000),
            ],
        ];
        _agent.BeforeLine = index =>
        {
            if (index == 4)
            {
                AppendEntries(next: "B-5", "## B-3 Таблица показывает ожидание\n\nСколько копия ждёт.\n\n### Агенту\n- где: App.tsx", "## B-4 Сортировка по номеру");
                TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            }
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "Хочу видеть ожидание и сортировку");
        var events = await Read(client, 6);

        Assert.Equal(new BacklogWriteEvent("reply", "Хочу видеть ожидание и сортировку"), events[0]);
        Assert.Equal(
            ["читает backlog-record.md", "ищет «Waiting» в frontend/src", "правит backlog.md", "коммитит бэклог"],
            events.Skip(1).Take(4).Select(e => e.Text));
        var answer = events[5];
        Assert.Equal("answer", answer.Type);
        Assert.Equal("Записал B-3 и B-4.", answer.Text);
        Assert.Equal(
            [new BacklogEntry("B-3", "Таблица показывает ожидание", "Сколько копия ждёт."), new BacklogEntry("B-4", "Сортировка по номеру", null)],
            answer.Entries);
        Assert.Equal(Git("log", "-1", "--format=%h"), answer.Commit);
        Assert.Equal(41000, answer.DurationMs);
        Assert.Null(answer.Proposal);
    }

    [Fact]
    public async Task Write_RunsClaudeInProjectCopyWithBacklogSkillAndOnlyBacklogPermissions()
    {
        _agent.Answers = [[Result("ok")]];
        var client = Client(_base);

        await Start(client, "  --help и мысль  ");
        await Read(client, 2);

        var startInfo = Assert.Single(_agent.Starts);
        Assert.Equal("claude", startInfo.FileName);
        Assert.Equal(_copy, startInfo.WorkingDirectory);
        Assert.True(startInfo.CreateNoWindow);
        Assert.Equal("/agents-kit:backlog --help и мысль", Said(_agent.Input[0]));

        var args = startInfo.ArgumentList.ToList();
        Assert.Contains("-p", args);
        Assert.Equal("stream-json", args[args.IndexOf("--input-format") + 1]);
        Assert.Equal("Read,Grep,Glob,Edit,PowerShell,Skill", args[args.IndexOf("--tools") + 1]);
        Assert.Equal("dontAsk", args[args.IndexOf("--permission-mode") + 1]);
        Assert.Equal(_base, args[args.IndexOf("--add-dir") + 1]);
        var allowed = args.Skip(args.IndexOf("--allowedTools") + 1).TakeWhile(a => !a.StartsWith("--")).ToList();
        Assert.Equal(["Read", "Grep", "Glob", "Skill", $"Edit({BacklogPath})", $"PowerShell({Commit})"], allowed);
        // Правило пускает команду, только когда она записана целиком, поэтому промпт диктует её слово в слово.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains(Commit, prompt);
        Assert.Contains("~~~backlog", prompt);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        Assert.DoesNotContain(args, a => a.Contains("dangerously", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(args, a => a.Contains("bypassPermissions", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Write_FromEntryNamesItForAgentAndInReply()
    {
        _agent.Answers = [[Result("Что поменять в B-1?")]];
        var client = Client(_base);

        await Start(client, "поправь приоритет", "в-1");
        var events = await Read(client, 2);

        Assert.Equal(new BacklogWriteEvent("reply", "поправь приоритет", Number: "B-1"), events[0]);
        Assert.Equal("/agents-kit:backlog Про запись B-1: поправь приоритет", Said(_agent.Input[0]));
        Assert.Equal(new BacklogWriteEvent("answer", "Что поменять в B-1?", DurationMs: 1000), events[1]);
    }

    [Fact]
    public async Task Reply_ContinuesConversationInSameAgentWithoutSkillAgain()
    {
        _agent.Answers = [[Result("Какую запись — B-1 «Старая запись»?")], [Result("Понял.")]];
        var client = Client(_base);

        await Start(client, "удали старую");
        await Read(client, 2);
        Assert.Equal(HttpStatusCode.NoContent, (await Reply(client, "да, её")).StatusCode);
        var events = await Read(client, 4);

        Assert.Equal(new BacklogWriteEvent("reply", "да, её"), events[2]);
        Assert.Equal("answer", events[3].Type);
        Assert.Single(_agent.Starts);
        Assert.Equal("да, её", Said(_agent.Input[1]));
    }

    [Fact]
    public async Task Reply_AfterAgentEndedRaisesNewAgentWithSkillAndSaysItForgot()
    {
        _agent.Answers = [[Result("Записал.")], [Result("Понял.")]];
        _agent.StopAfter = 1;
        var client = Client(_base);

        await Start(client, "мысль");
        await Read(client, 2);
        await Reply(client, "ещё одна");
        var events = await Read(client, 5);

        Assert.Equal(new BacklogWriteEvent("note", "Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит"), events[2]);
        Assert.Equal(new BacklogWriteEvent("reply", "ещё одна"), events[3]);
        Assert.Equal(2, _agent.Starts.Count);
        Assert.Equal("/agents-kit:backlog ещё одна", Said(_agent.Input[1]));
    }

    [Fact]
    public async Task Answer_WithChangeProposal_LeavesFileAndSaveWritesExactlyThatEntry()
    {
        var changed = "## B-1 Старая запись, переписанная\nтип: баг\nприоритет: высокий\n\nНовый текст.\n\n### Агенту\n- где: Backlog.tsx";
        _agent.Answers = [[Result($"Предлагаю так.\n\n~~~backlog\nизменить B-1\n{changed}\n~~~\n")]];
        var client = Client(_base);
        var file = File.ReadAllText(BacklogPath);

        await Start(client, "B-1 — это баг, высокий");
        var answer = (await Read(client, 2))[1];

        Assert.Equal("answer", answer.Type);
        Assert.Equal("Предлагаю так.", answer.Text);
        var change = Assert.Single(answer.Proposal!.Changes);
        Assert.Equal(BacklogChange.Change, change.Kind);
        Assert.Equal("B-1", change.Number);
        Assert.Equal(new BacklogEntry("B-1", "Старая запись, переписанная", "Новый текст.", "высокий", "баг"), change.Entry);
        Assert.Equal(file, File.ReadAllText(BacklogPath));

        var saved = await Save(client, answer.Proposal.Id);

        Assert.Null(saved.Error);
        Assert.Equal(file.Replace(
            "## B-1 Старая запись\nтип: фича\nприоритет: средний\n\nТекст старой записи.\n\n### Агенту\n- где: App.tsx",
            changed), File.ReadAllText(BacklogPath));
        Assert.Equal(BacklogConversations.SaveMessage, Git("log", "-1", "--format=%s"));
        Assert.Equal(saved.Commit, Git("log", "-1", "--format=%h"));
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Equal(new BacklogWriteEvent("saved", "", Commit: saved.Commit, ProposalId: answer.Proposal.Id), (await Read(client, 3))[2]);
    }

    [Fact]
    public async Task Save_MergesByChangingOneEntryAndCuttingTheOther()
    {
        _agent.Answers =
        [
            [Result("~~~backlog\nизменить B-1\n## B-1 Старая и вторая\n\nОба текста.\n\n### Агенту\n- где: App.tsx\n~~~\n~~~backlog\nудалить B-2 в B-1\n~~~")],
        ];
        var client = Client(_base);

        await Start(client, "объедини B-1 и B-2");
        var answer = (await Read(client, 2))[1];

        var delete = answer.Proposal!.Changes[1];
        Assert.Equal(
            (BacklogChange.Delete, "B-2", new BacklogEntry("B-2", "Вторая запись", "Текст второй записи."), "B-1"),
            (delete.Kind, delete.Number, delete.Entry, delete.Into));

        Assert.Null((await Save(client, answer.Proposal.Id)).Error);
        Assert.Equal(
            "# Order Service — бэклог\n\nследующий номер: B-3\nполя: тип, приоритет\n\n## B-1 Старая и вторая\n\nОба текста.\n\n### Агенту\n- где: App.tsx\n",
            File.ReadAllText(BacklogPath));
    }

    [Fact]
    public async Task Save_RefusesEntryChangedAfterAnswer()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];
        File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("Текст второй записи.", "Поправлено соседней сессией."));
        TestGit.Run(_base, "commit", "-m", "сосед", "--", "backlog.md");
        var file = File.ReadAllText(BacklogPath);

        var saved = await Save(client, answer.Proposal!.Id);

        Assert.Equal("Запись B-2 изменилась после ответа Чудо-Юдо — ничего не записано", saved.Error);
        Assert.Equal(file, File.ReadAllText(BacklogPath));
        Assert.Equal("сосед", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_RefusesUncommittedBacklogEdit()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];
        File.AppendAllText(BacklogPath, "\nчужая правка\n");

        var saved = await Save(client, answer.Proposal!.Id);

        Assert.Equal("В backlog.md базы есть незакоммиченная правка — ничего не записано", saved.Error);
        Assert.EndsWith("чужая правка\n", File.ReadAllText(BacklogPath));
        Assert.Equal("base", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Save_ReturnsFileWhenCommitIsRefused()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];
        var file = File.ReadAllText(BacklogPath);
        File.WriteAllText(Path.Combine(_base, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho сверка не прошла\nexit 1\n");

        var saved = await Save(client, answer.Proposal!.Id);

        Assert.Equal("Коммит не прошёл — backlog.md оставлен как был", saved.Error);
        Assert.Contains("сверка не прошла", saved.Output);
        Assert.Equal(file, File.ReadAllText(BacklogPath));
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Refuse_MarksProposalAndItCannotBeSavedAfter()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];

        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/backlog/write/refuse", new BacklogProposalRequest(answer.Proposal!.Id))).StatusCode);

        Assert.Equal(new BacklogWriteEvent("refused", "", ProposalId: answer.Proposal.Id), (await Read(client, 3))[2]);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/backlog/write/save", new BacklogProposalRequest(answer.Proposal.Id))).StatusCode);
        Assert.Equal("base", Git("log", "-1", "--format=%s"));
    }

    [Fact]
    public async Task Reply_ReplacesUnsavedProposal()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")], [Result("~~~backlog\nудалить B-1\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var first = (await Read(client, 2))[1];

        await Reply(client, "нет, B-1");
        var second = (await Read(client, 4))[3];

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/backlog/write/save", new BacklogProposalRequest(first.Proposal!.Id))).StatusCode);
        Assert.Null((await Save(client, second.Proposal!.Id)).Error);
        Assert.DoesNotContain("## B-1", File.ReadAllText(BacklogPath));
        Assert.Contains("## B-2", File.ReadAllText(BacklogPath));
    }

    [Fact]
    public async Task Answer_ReportsAgentThatEditedExistingEntryItself()
    {
        _agent.Answers = [[Result("Удалил B-2.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("## B-2 Вторая запись\n\nТекст второй записи.\n", ""));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "удали B-2");
        var error = (await Read(client, 2))[1];

        Assert.Equal("error", error.Type);
        Assert.Equal($"Чудо-Юдо сам изменил записи B-2 вместо предложения: правка уже в истории базы, коммит {Git("log", "-1", "--format=%h")}", error.Text);
        Assert.Equal("Удалил B-2.", error.Output);
    }

    [Fact]
    public async Task Save_RefusesProposalOfRemovedConversation()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];

        await client.DeleteAsync("/api/agent/backlog");

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/backlog/write/save", new BacklogProposalRequest(answer.Proposal!.Id))).StatusCode);
        Assert.Contains("## B-2", File.ReadAllText(BacklogPath));
    }

    [Fact]
    public async Task Reply_AfterAgentEndedRemindsNewAgentOfTheEntry()
    {
        _agent.Answers = [[Result("Что поменять?")], [Result("Понял.")]];
        _agent.StopAfter = 1;
        var client = Client(_base);

        await Start(client, "поправь", "B-1");
        await Read(client, 2);
        await Reply(client, "приоритет высокий");
        await Read(client, 5);

        Assert.Equal("/agents-kit:backlog Про запись B-1: приоритет высокий", Said(_agent.Input[1]));
    }

    [Fact]
    public async Task Answer_AcceptsSkillAddingLineToFoundEntry()
    {
        // Навык кита дописывает просьбу, которая легла в найденную запись, строкой в её «Агенту» — это не правка.
        _agent.Answers = [[Result("Дописал в B-1.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("- где: App.tsx\n", "- где: App.tsx\n- ещё случай из панели\n"));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "и ещё случай про B-1");
        var answer = (await Read(client, 2))[1];

        Assert.Equal(new BacklogWriteEvent("answer", "Дописал в B-1.", DurationMs: 1000), answer);
    }

    [Fact]
    public async Task Answer_ReportsProposalForUnknownEntry()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-9\n~~~")]];
        var client = Client(_base);

        await Start(client, "удали B-9");
        var error = (await Read(client, 2))[1];

        Assert.Equal("error", error.Type);
        Assert.Equal("Чудо-Юдо предложил правку, которую панель не поняла: Записи B-9 в бэклоге нет", error.Text);
    }

    [Fact]
    public async Task Answer_ReportsEntriesLeftUncommitted()
    {
        _agent.Answers = [[Result("Коммит отклонён сверкой.")]];
        _agent.BeforeLine = _ =>
        {
            AppendEntries(next: "B-4", "## B-3 Новая запись");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "Мысль");
        var error = (await Read(client, 2))[1];

        Assert.Equal("Бэклог изменён, но backlog.md не закоммичен", error.Text);
        Assert.Equal([new BacklogEntry("B-3", "Новая запись", null)], error.Entries);
        Assert.Equal("Коммит отклонён сверкой.", error.Output);
    }

    [Fact]
    public async Task Answer_ReportsAgentErrorWithItsText()
    {
        _agent.Answers = [["""{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"""]];
        var client = Client(_base);

        await Start(client, "Мысль");
        var error = (await Read(client, 2))[1];

        Assert.Equal("error", error.Type);
        Assert.Equal("Invalid API key · Please run /login", error.Output);
        Assert.Null(error.Entries);
    }

    [Fact]
    public async Task Write_DoesNotSendOverUncommittedBacklogEdit()
    {
        File.AppendAllText(BacklogPath, "\nчужая правка\n");
        var client = Client(_base);

        await Start(client, "Мысль");
        var events = await Read(client, 2);

        Assert.Equal("В backlog.md базы есть незакоммиченная правка — просьба не отправлена", events[1].Text);
        Assert.Empty(_agent.Input);
    }

    [Fact]
    public async Task Write_DoesNotStartWithoutProjectCopyOnDisk()
    {
        Directory.Delete(_copy, recursive: true);
        var client = Client(_base);

        await Start(client, "Мысль");
        var events = await Read(client, 2);

        Assert.Equal("error", events[1].Type);
        Assert.Empty(_agent.Input);
    }

    [Fact]
    public async Task Write_RejectsBaseOutsideListAndEmptyText()
    {
        var other = Path.Combine(_root, "other");
        Directory.CreateDirectory(other);
        var client = Client(_base);

        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Post(other, "Мысль"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "  "))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Post(_base, "Мысль", "не номер"))).StatusCode);
        Assert.Empty(_agent.Starts);
    }

    public void Dispose()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void AppendEntries(string next, params string[] entries)
    {
        var text = File.ReadAllText(BacklogPath).Replace("следующий номер: B-3", $"следующий номер: {next}");
        File.WriteAllText(BacklogPath, text + "\n" + string.Join("\n\n", entries) + "\n");
    }

    private string Git(params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = _base,
            RedirectStandardOutput = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)!;
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return output;
    }

    /// <summary>Текст реплики, ушедшей агенту строкой stream-json.</summary>
    private static string Said(string line) =>
        JsonDocument.Parse(line).RootElement.GetProperty("message").GetProperty("content")[0].GetProperty("text").GetString()!;

    private static string Tool(string name, object input) => JsonSerializer.Serialize(new
    {
        type = "assistant",
        message = new { content = new object[] { new { type = "tool_use", name, input } } },
    });

    private static string Result(string text, long durationMs = 1000) => JsonSerializer.Serialize(new
    {
        type = "result",
        subtype = "success",
        is_error = false,
        duration_ms = durationMs,
        result = text,
    });

    private static HttpRequestMessage Post(string basePath, string text, string? number = null) =>
        new(HttpMethod.Post, "/api/backlog/write") { Content = JsonContent.Create(new BacklogWriteRequest(basePath, text, number)) };

    private async Task Start(HttpClient client, string text, string? number = null)
    {
        using var started = await client.SendAsync(Post(_base, text, number));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
    }

    private static Task<HttpResponseMessage> Reply(HttpClient client, string text) =>
        client.PostAsJsonAsync("/api/backlog/write/reply", new AskReply(text));

    private static async Task<BacklogSaved> Save(HttpClient client, string id)
    {
        using var response = await client.PostAsJsonAsync("/api/backlog/write/save", new BacklogProposalRequest(id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<BacklogSaved>(Json))!;
    }

    /// <summary>Как окно: переписка читается потоком просьбы с начала и ждёт следующих событий в нём же.</summary>
    private static async Task<List<BacklogWriteEvent>> Read(HttpClient client, int count)
    {
        using var response = await client.GetAsync("/api/agent/backlog/stream?from=0", HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var events = new List<BacklogWriteEvent>();
        while (events.Count < count)
        {
            var line = await reader.ReadLineAsync().WaitAsync(Wait);
            Assert.NotNull(line);
            if (line.Trim().Length > 0)
                events.Add(JsonSerializer.Deserialize<BacklogWriteEvent>(line, Json)!);
        }
        return events;
    }

    private HttpClient Client(params string[] bases) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.Sources.Clear();
                config.AddInMemoryCollection([new("BasesFile", TestBases.File(_root, bases))]);
            });
            // Настоящий claude в прогоне не запускается: проверяется, как панель его зовёт и что выводит из базы.
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IAgentChat>();
                services.AddSingleton<IAgentChat>(_agent);
            });
        }).CreateClient();
}
