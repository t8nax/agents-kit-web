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
    // С запасом: до события идёт цепочка git, и на перегруженной машине десяти секунд не хватало (B-142).
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(30);

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
    private readonly TestHosts _hosts = new();
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
        Assert.Equal(["Read", "Grep", "Glob", "Skill", $"Edit({BacklogPath})", $"PowerShell({Commit})", $"PowerShell({Commit} artifacts)"], allowed);
        // Правило пускает команду, только когда она записана целиком, поэтому промпт диктует её слово в слово.
        var prompt = args[args.IndexOf("--append-system-prompt") + 1];
        Assert.Contains(Commit, prompt);
        Assert.Contains("~~~backlog", prompt);
        Assert.DoesNotContain(args, a => a.Contains("--help"));
        Assert.DoesNotContain(args, a => a.Contains("dangerously", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(args, a => a.Contains("bypassPermissions", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Write_AttachedFileGoesToBaseArtifactsAndAgentCommitsItWithEntry()
    {
        // Навык вписывает приложенный файл в «Артефакты» записи и коммитит второй разрешённой командой.
        _agent.Answers = [[Result("Приложил к B-1.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace(
                "### Агенту\n- где: App.tsx\n", "### Артефакты\n- снимок: artifacts/B-1-Снимок-экрана.png\n\n### Агенту\n- где: App.tsx\n"));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md", "artifacts");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        using var started = await client.SendAsync(Post(_base, "приложи снимок", "B-1", [Shot("Снимок экрана.png", 3)]));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var events = await Read(client, 2);

        Assert.Equal(["artifacts/B-1-Снимок-экрана.png"], events[0].Files);
        Assert.Contains("artifacts/B-1-Снимок-экрана.png", Said(_agent.Input[0]));
        Assert.Equal(new BacklogWriteEvent("answer", "Приложил к B-1.", DurationMs: 1000), events[1]);
        Assert.Equal([0, 1, 2], File.ReadAllBytes(Path.Combine(_base, "artifacts", "B-1-Снимок-экрана.png")));
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Write_AttachedFileLeftByAgentIsCommittedByPanel()
    {
        // Агент закоммитил только backlog.md: ссылка уже в истории, и файл докоммичивает панель.
        _agent.Answers = [[Result("Записал B-3.")]];
        _agent.BeforeLine = _ =>
        {
            File.AppendAllText(BacklogPath, "\n## B-3 Новая\n\nТекст.\n\n### Артефакты\n- лог: artifacts/лог.txt\n");
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        using var started = await client.SendAsync(Post(_base, "запиши", files: [Shot("лог.txt", 2)]));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var answer = (await Read(client, 2))[1];

        Assert.Equal("answer", answer.Type);
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Contains("artifacts/лог.txt", Git("-c", "core.quotepath=false", "log", "-1", "--name-only", "--format="));
    }

    [Fact]
    public async Task Write_AttachedFileNotYetUsedLeavesIndexCleanAndNewTalkRemovesIt()
    {
        // Агент переспросил, файл ещё не вписан: между ходами он лежит на диске, но не в индексе базы.
        _agent.Answers = [[Result("Это к B-1 «Старая запись»?")]];
        var client = Client(_base);

        using var started = await client.SendAsync(Post(_base, "приложи снимок к старой записи", files: [Shot("снимок.png", 3)]));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        await Read(client, 2);

        Assert.True(File.Exists(Path.Combine(_base, "artifacts", "снимок.png")));
        Assert.Equal("", Git("diff", "--cached", "--name-only"));

        _agent.Answers = [[Result("ok")]];
        await Start(client, "другая просьба");

        Assert.False(File.Exists(Path.Combine(_base, "artifacts", "снимок.png")));
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Reply_DeclinedFileDoesNotRideWithNextFileCommit()
    {
        // Первый файл оператор отозвал словами, ко второй реплике приложил другой: коммит агента с artifacts
        // берёт только файл этой реплики.
        _agent.Answers = [[Result("Это к B-1?")], [Result("Записал B-3.")]];
        _agent.BeforeLine = _ =>
        {
            if (_agent.Input.Count != 2)
                return Task.CompletedTask;
            File.AppendAllText(BacklogPath, "\n## B-3 Новая\n\nТекст.\n\n### Артефакты\n- лог: artifacts/лог.txt\n");
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md", "artifacts");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        using var started = await client.SendAsync(Post(_base, "приложи снимок", files: [Shot("снимок.png", 3)]));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        await Read(client, 2);
        using var replied = await client.PostAsJsonAsync(
            "/api/backlog/write/reply", new BacklogReplyRequest("снимок не нужен, запиши новую с логом", [Shot("лог.txt", 2)]));
        Assert.Equal(HttpStatusCode.NoContent, replied.StatusCode);
        Assert.Equal("answer", (await Read(client, 4))[3].Type);

        Assert.Equal("A\tartifacts/лог.txt\nM\tbacklog.md", Git("-c", "core.quotepath=false", "show", "--name-status", "--format=", "HEAD"));
        Assert.Equal("", Git("diff", "--cached", "--name-only"));
        Assert.True(File.Exists(Path.Combine(_base, "artifacts", "снимок.png")));
    }

    [Fact]
    public async Task Write_NewTalkReleasesFileLeftInIndexWithoutReference()
    {
        // Ход оборвала остановка панели: файл остался в индексе, а новая панель его не помнит.
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        File.WriteAllText(Path.Combine(_base, "artifacts", "брошенный.txt"), "1");
        TestGit.Run(_base, "add", "artifacts");
        _agent.Answers = [[Result("ok")]];
        var client = Client(_base);

        await Start(client, "запиши");
        var events = await Read(client, 2);

        Assert.Equal("answer", events[1].Type);
        Assert.Equal("", Git("diff", "--cached", "--name-only"));
        Assert.True(File.Exists(Path.Combine(_base, "artifacts", "брошенный.txt")));
    }

    [Fact]
    public async Task Save_CommitsAttachedFileTheProposalReferences()
    {
        // Файл приложен к просьбе про существующую запись: строка о нём приходит предложением и уходит по «Сохранить».
        _agent.Answers =
        [
            [Result("~~~backlog\nизменить B-1\n## B-1 Старая запись\nтип: фича\nприоритет: средний\n\nТекст старой записи.\n\n### Артефакты\n- снимок: artifacts/B-1-снимок.png\n\n### Агенту\n- где: App.tsx\n~~~")],
        ];
        var client = Client(_base);

        using var started = await client.SendAsync(Post(_base, "приложи снимок", "B-1", [Shot("снимок.png", 3)]));
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        var answer = (await Read(client, 2))[1];
        Assert.Equal("", Git("diff", "--cached", "--name-only"));

        Assert.Null((await Save(client, answer.Proposal!.Id)).Error);
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Equal(
            "A\tartifacts/B-1-снимок.png\nM\tbacklog.md",
            Git("-c", "core.quotepath=false", "show", "--name-status", "--format=", "HEAD"));
    }

    [Fact]
    public async Task Save_MergeRemovesArtifactsOfGoneEntryButKeepsOnesAnotherEntryHolds()
    {
        File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath)
            .Replace("### Агенту\n- где: App.tsx\n", "### Артефакты\n- общий: artifacts/общий.txt\n\n### Агенту\n- где: App.tsx\n")
            .Replace("Текст второй записи.\n", "Текст второй записи.\n\n### Артефакты\n- общий: artifacts/общий.txt\n- свой: artifacts/свой.txt\n"));
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        File.WriteAllText(Path.Combine(_base, "artifacts", "общий.txt"), "1");
        File.WriteAllText(Path.Combine(_base, "artifacts", "свой.txt"), "2");
        TestGit.Run(_base, "add", ".");
        TestGit.Run(_base, "commit", "-m", "артефакты");
        _agent.Answers =
        [
            [Result("~~~backlog\nизменить B-1\n## B-1 Старая и вторая\n\nОба текста.\n\n### Артефакты\n- общий: artifacts/общий.txt\n\n### Агенту\n- где: App.tsx\n~~~\n~~~backlog\nудалить B-2 в B-1\n~~~")],
        ];
        var client = Client(_base);
        await Start(client, "объедини B-1 и B-2");
        var answer = (await Read(client, 2))[1];

        Assert.Null((await Save(client, answer.Proposal!.Id)).Error);

        Assert.True(File.Exists(Path.Combine(_base, "artifacts", "общий.txt")));
        Assert.False(File.Exists(Path.Combine(_base, "artifacts", "свой.txt")));
        Assert.Equal("", Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Write_TooLargeFileIsRefusedAndNothingLands()
    {
        var client = Client(_base);

        using var response = await client.SendAsync(Post(_base, "приложи", files: [Shot("видео.mp4", 5 * 1024 * 1024 + 1)]));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new AttachRejected("видео.mp4", "too-large"), await response.Content.ReadFromJsonAsync<AttachRejected>(Json));
        Assert.False(Directory.Exists(Path.Combine(_base, "artifacts")));
        Assert.Empty(_agent.Starts);
    }

    [Fact]
    public async Task Write_IsNotSentOverForeignUncommittedArtifact()
    {
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        File.WriteAllText(Path.Combine(_base, "artifacts", "чужой.txt"), "соседняя сессия");
        TestGit.Run(_base, "add", "artifacts/чужой.txt");
        // Соседняя сессия уже сослалась на свой файл из памяти задачи: это не брошенный файл, и панель его не трогает.
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllText(Path.Combine(_base, "work", "сосед.md"), "## Артефакты\n- лог: artifacts/чужой.txt\n");
        var client = Client(_base);

        await Start(client, "запиши");
        var events = await Read(client, 2);

        Assert.Equal(new BacklogWriteEvent("error", "В artifacts/ базы есть чужая незакоммиченная правка — просьба не отправлена"), events[1]);
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
        var listed = await client.GetFromJsonAsync<AgentRequestSummary[]>("/api/agent/requests", Json);
        Assert.Equal("B-1", Assert.Single(listed!).Subject);
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
    public async Task Save_DeletingEntryRemovesItsArtifactsNobodyElseReferences()
    {
        // B-2 несёт два файла: снимок только у неё, лог ещё и у памяти задачи — он остаётся.
        File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace(
            "Текст второй записи.\n",
            "Текст второй записи.\n\n### Артефакты\n- снимок: artifacts/B-2-снимок.png\n- лог: artifacts/B-2-лог.txt\n- макет: https://claude.ai/artifact/AbC\n"));
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        File.WriteAllBytes(Path.Combine(_base, "artifacts", "B-2-снимок.png"), [1, 2, 3]);
        File.WriteAllText(Path.Combine(_base, "artifacts", "B-2-лог.txt"), "лог");
        File.WriteAllText(Path.Combine(_base, "work", "app.md"), "# B-9\n\n## Артефакты\n- лог: artifacts/B-2-лог.txt\n");
        TestGit.Run(_base, "add", ".");
        TestGit.Run(_base, "commit", "-m", "артефакты");
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];

        var saved = await Save(client, answer.Proposal!.Id);

        Assert.Null(saved.Error);
        Assert.False(File.Exists(Path.Combine(_base, "artifacts", "B-2-снимок.png")));
        Assert.True(File.Exists(Path.Combine(_base, "artifacts", "B-2-лог.txt")));
        Assert.Equal("", Git("status", "--porcelain"));
        Assert.Equal("D\tartifacts/B-2-снимок.png\nM\tbacklog.md", Git("-c", "core.quotepath=false", "show", "--name-status", "--format=", "HEAD"));
    }

    [Fact]
    public async Task Save_RefusedCommitReturnsDeletedArtifacts()
    {
        File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace(
            "Текст второй записи.\n", "Текст второй записи.\n\n### Артефакты\n- снимок: artifacts/B-2-снимок.png\n"));
        Directory.CreateDirectory(Path.Combine(_base, "artifacts"));
        File.WriteAllBytes(Path.Combine(_base, "artifacts", "B-2-снимок.png"), [1, 2, 3]);
        TestGit.Run(_base, "add", ".");
        TestGit.Run(_base, "commit", "-m", "артефакты");
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];
        File.WriteAllText(Path.Combine(_base, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho сверка не прошла\nexit 1\n");

        var saved = await Save(client, answer.Proposal!.Id);

        Assert.Equal("Коммит не прошёл — backlog.md оставлен как был", saved.Error);
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(_base, "artifacts", "B-2-снимок.png")));
        Assert.Equal("", Git("status", "--porcelain"));
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
    public async Task Answer_AcceptsSkillAddingArtifactToFoundEntry()
    {
        // Приложенный файл к найденной записи навык кладёт строкой в её «Артефакты», заводя подраздел, — это не правка.
        _agent.Answers = [[Result("Приложил к B-1.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath)
                .Replace("### Агенту\n- где: App.tsx\n", "### Артефакты\n- снимок: artifacts/B-1-снимок.png\n\n### Агенту\n- где: App.tsx\n"));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "приложи снимок к B-1");
        var answer = (await Read(client, 2))[1];

        Assert.Equal(new BacklogWriteEvent("answer", "Приложил к B-1.", DurationMs: 1000), answer);
    }

    [Fact]
    public async Task Reply_IsRefusedWhileProposalIsBeingSaved()
    {
        _agent.Answers = [[Result("~~~backlog\nудалить B-2\n~~~")]];
        var client = Client(_base);
        await Start(client, "удали B-2");
        var answer = (await Read(client, 2))[1];
        // Сверка базы долгая: коммит «Сохранить» идёт секунды, и реплика приходит посреди него.
        File.WriteAllText(Path.Combine(_base, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 3\n");

        var saving = client.PostAsJsonAsync("/api/backlog/write/save", new BacklogProposalRequest(answer.Proposal!.Id));
        await Task.Delay(1000);
        var reply = await Reply(client, "и ещё");

        Assert.Equal(HttpStatusCode.Conflict, reply.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await saving).StatusCode);
        Assert.Single(_agent.Input);
    }

    [Fact]
    public async Task Answer_ReportsUncommittedRewriteOfExistingEntry()
    {
        _agent.Answers = [[Result("Переписал B-2.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("Текст второй записи.", "Текст второй записи, и ещё фраза."));
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "перепиши B-2");
        var error = (await Read(client, 2))[1];

        Assert.Equal("Чудо-Юдо сам изменил записи B-2 вместо предложения: правка не закоммичена — backlog.md остался изменённым", error.Text);
    }

    [Fact]
    public async Task Answer_ReportsNewPhraseInOperatorTextAsRewrite()
    {
        // Навык дописывает только «Агенту» и поля: вставленная фраза в тексте оператору — уже правка.
        _agent.Answers = [[Result("Дополнил B-2.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath).Replace("Текст второй записи.\n", "Текст второй записи.\n\nНовая фраза.\n"));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "дополни B-2");
        var error = (await Read(client, 2))[1];

        Assert.StartsWith("Чудо-Юдо сам изменил записи B-2 вместо предложения", error.Text);
    }

    [Fact]
    public async Task Answer_ReportsGitThatDidNotAnswer()
    {
        _agent.Answers = [[Result("Ничего не менял.")]];
        _agent.BeforeLine = _ =>
        {
            Directory.Move(Path.Combine(_base, ".git"), Path.Combine(_base, ".git-off"));
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "покажи");
        var error = (await Read(client, 2))[1];

        Assert.Equal("git не прочитал базу — итог ответа не проверен", error.Text);
    }

    [Fact]
    public async Task Answer_DoesNotShowRenumberedForeignEntryAsNew()
    {
        File.AppendAllText(BacklogPath, "\n## ORD-5 Запись чужими буквами\n\nТекст чужой.\n");
        TestGit.Run(_base, "commit", "-m", "чужая", "--", "backlog.md");
        _agent.Answers = [[Result("Перенумеровал ORD-5 в B-3.")]];
        _agent.BeforeLine = _ =>
        {
            File.WriteAllText(BacklogPath, File.ReadAllText(BacklogPath)
                .Replace("следующий номер: B-3", "следующий номер: B-4")
                .Replace("## ORD-5 Запись чужими буквами", "## B-3 Запись чужими буквами"));
            TestGit.Run(_base, "commit", "-m", BacklogWriteEndpoints.CommitMessage, "--", "backlog.md");
            return Task.CompletedTask;
        };
        var client = Client(_base);

        await Start(client, "покажи бэклог");
        var answer = (await Read(client, 2))[1];

        Assert.Equal("answer", answer.Type);
        Assert.Null(answer.Entries);
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
        _hosts.Dispose();
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

    private static HttpRequestMessage Post(string basePath, string text, string? number = null, IReadOnlyList<AttachedFile>? files = null) =>
        new(HttpMethod.Post, "/api/backlog/write") { Content = JsonContent.Create(new BacklogWriteRequest(basePath, text, number, files)) };

    // Файл из окна: байты 0, 1, 2… нужной длины.
    private static AttachedFile Shot(string name, int length) =>
        new(name, Convert.ToBase64String(Enumerable.Range(0, length).Select(i => (byte)i).ToArray()));

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
        _hosts.Add(new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
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
        })).CreateClient();
}
