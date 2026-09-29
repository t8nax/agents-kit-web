using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

public sealed record AskBase(string Base, string Project);

public sealed record AskRequest(string? Base, string? Question, string? Copy = null);

public sealed record AskReply(string? Text);

/// <summary>Чем кончилась попытка отправить реплику в разговор.</summary>
public enum AskReplied
{
    Sent,
    NoConversation,
    Answering,
}

/// <summary>
/// Разговор оператора с агентом по одной базе и коду одной копии её проекта. Переписку держит просьба панели, память разговора — живой
/// процесс агента: реплики уходят ему в stdin по одной, и сессия на диск не ложится — решения оператора
/// на B-79. Разом идёт один разговор: новый останавливает прежний.
/// </summary>
public sealed class AskConversations(IAgentChat agent, AgentRequests requests)
{
    /// <summary>Сколько ждать ответа на одну реплику. Между репликами процесс стоит сколько угодно.</summary>
    private static readonly TimeSpan Answer = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private Turn? _turn;

    public AgentRequestSummary Start(string basePath, string? copyPath, string question)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, copyPath);
        var request = requests.Start(
            AgentRequests.Ask,
            basePath,
            ProjectName.Of(basePath),
            question,
            (asking, cancellationToken) => RunAsync(basePath, replies.Reader, turn, asking, cancellationToken),
            continues: true,
            // Копию разговора окно, открытое заново, берёт отсюда: выбрать другую посреди разговора нельзя.
            subject: copyPath,
            reply: new AskEvent("reply", question));

        turn.Request = request;
        lock (_gate)
        {
            _turn = turn;
            if (!turn.Ended)
                Send(turn, question);
        }
        return request.Summary;
    }

    public AskReplied Reply(string text)
    {
        if (requests.Of(AgentRequests.Ask) is not { Continues: true } request)
            return AskReplied.NoConversation;
        // Пока идёт ответ, следующая реплика не отправляется: окно её и не даёт набрать.
        if (!request.Finished)
            return AskReplied.Answering;

        // Агент выбирается и реплика уходит в его очередь под той же блокировкой, которой его работа отмечает свой
        // конец: кончившемуся агенту она не достаётся, а поднимает нового (B-262, как B-259 у бэклога).
        lock (_gate)
        {
            var turn = _turn?.Request == request && request.Working && !_turn.Ended ? _turn : null;
            // Новый агент читает ту же копию, что прежний: копия, как и база, одна на разговор, и помнит её просьба.
            turn ??= Restart(request, request.Subject);
            request.Reply(new AskEvent("reply", text));
            Send(turn, text);
        }
        return AskReplied.Sent;
    }

    /// <summary>
    /// «Отменить»: нынешний ответ обрывается вместе с процессом агента, а переписка остаётся на экране —
    /// критерий B-79. Следующая реплика поднимет нового агента и скажет, что прошлого он не помнит.
    /// </summary>
    public bool Stop()
    {
        if (requests.Of(AgentRequests.Ask) is not { Continues: true } request || request.Finished)
            return false;

        lock (_gate)
        {
            if (_turn?.Request != request)
                return false;
            _turn.Stopped = true;
            _turn.Timeout.Cancel();
        }
        return true;
    }

    /// <summary>
    /// Процесс прежнего разговора кончился — сорвался или остановлен. Переписка остаётся на экране, новый
    /// процесс поднимается на следующей реплике, и панель честно говорит, что прошлого он не помнит.
    /// </summary>
    private Turn Restart(AgentRequest request, string? copyPath)
    {
        var replies = Channel.CreateUnbounded<string>();
        var turn = new Turn(replies.Writer, copyPath) { Request = request };
        lock (_gate)
            _turn = turn;

        request.Write(new AskEvent(
            "note", $"{AgentRequests.AgentName} отвечает заново: сказанного раньше он уже не помнит"));
        requests.Run(
            request,
            (asking, cancellationToken) => RunAsync(request.Base, replies.Reader, turn, asking, cancellationToken));
        return turn;
    }

    /// <summary>Реплика уходит агенту строкой stdin; пошёл отсчёт ответа. Зовётся под блокировкой разговора.</summary>
    private static void Send(Turn turn, string text)
    {
        turn.Said = text;
        turn.Timeout.CancelAfter(Answer);
        turn.Replies.TryWrite(Message(text));
    }

    /// <summary>
    /// Агент кончился: его очередь реплик больше не принимает. Возвращает реплику, которая в ней осталась, — её
    /// агент так и не прочёл.
    /// </summary>
    private string? End(Turn turn, ChannelReader<string> replies)
    {
        lock (_gate)
        {
            turn.Ended = true;
            return replies.TryRead(out _) ? turn.Said : null;
        }
    }

    private async Task RunAsync(
        string basePath,
        ChannelReader<string> replies,
        Turn turn,
        AgentRequest asking,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, turn.Timeout.Token);
        var stream = new ClaudeStream(basePath, turn.Copy);
        try
        {
            var exit = await agent.RunAsync(
                StartInfo(basePath, turn.Copy),
                replies,
                line =>
                {
                    foreach (var e in stream.Read(line))
                        asking.Write(e);
                    if (stream.Finished)
                    {
                        // Реплика отвечена: следующей ждём сколько угодно, а прочитанные файлы считаются заново.
                        // Реплику, ради которой агент поднят, он прочёл: следующую, не прочтённую им, получит новый.
                        turn.Raised = false;
                        turn.Timeout.CancelAfter(Timeout.InfiniteTimeSpan);
                        stream = new ClaudeStream(basePath, turn.Copy);
                    }
                    return Task.CompletedTask;
                },
                linked.Token);
            if (End(turn, replies) is { } left && !turn.Raised)
            {
                // Реплика легла в очередь, когда агент уже кончался, и он её не прочёл: её получает новый, если
                // оператор не остановил ответ. Дошедшую до stdin выходящего процесса не вернуть — она кончится
                // сбоем ниже, как и та, которую не прочёл уже поднятый ради неё агент.
                lock (_gate)
                {
                    if (turn.Stopped)
                        asking.Write(new AskEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет"));
                    // Разговор, сменённый новым, агента себе не поднимает: новый разговор держит своего.
                    else if (_turn == turn)
                        Send(Restart(asking, turn.Copy), left);
                }
                return;
            }
            // Процесс кончился на неотвеченной реплике — это сбой; кончился между репликами — о нём скажет
            // следующая реплика, подняв нового агента.
            if (!asking.Finished)
                asking.Write(Failure(exit, stream));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            End(turn, replies);
            asking.Write(turn.Stopped
                ? new AskEvent("stopped", $"{AgentRequests.AgentName} остановлен: ответа на эту реплику не будет")
                : new AskEvent("error", $"{AgentRequests.AgentName} не ответил за пять минут и остановлен"));
        }
    }

    /// <summary>Реплика оператора в потоке stream-json: агент читает их построчно, по одной на ответ.</summary>
    private static string Message(string text) => JsonSerializer.Serialize(
        new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text } } },
        },
        AgentRequest.JsonOptions);

    /// <summary>
    /// Агент только читает: набор инструментов сужен до чтения, а не одобрен поверх остальных. Реплики уходят
    /// в stdin, а не в аргументы: текст оператора не должен стать флагом или командой. Копия проекта подана
    /// вторым каталогом: агент остаётся в базе, а код читает рядом с ней — тоже только чтением. Руководство
    /// панели — ещё одним каталогом: об устройстве самой панели оператор спрашивает здесь же (B-306).
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string? copyPath = null)
    {
        var guide = Directory.Exists(AskEndpoints.GuideDir) ? AskEndpoints.GuideDir : null;
        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, basePath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--input-format", "stream-json",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", AskEndpoints.Prompt(BaseLayout.Read(basePath)?.Operator, copyPath, guide),
                 })
            startInfo.ArgumentList.Add(arg);
        AgentProcess.AddAutoMode(startInfo);
        if (copyPath is not null)
        {
            startInfo.ArgumentList.Add("--add-dir");
            startInfo.ArgumentList.Add(copyPath);
        }
        if (guide is not null)
        {
            startInfo.ArgumentList.Add("--add-dir");
            startInfo.ArgumentList.Add(guide);
        }
        return startInfo;
    }

    private static AskEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new AskEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new AskEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без ответа",
            Output: output.Length > 0 ? output : $"код выхода {exit.ExitCode}");
    }

    /// <summary>Живой процесс разговора: кому уходят реплики, сколько ждать ответа и не остановлен ли он.</summary>
    private sealed class Turn(ChannelWriter<string> replies, string? copy)
    {
        public ChannelWriter<string> Replies { get; } = replies;

        /// <summary>Копия проекта, чей код читает агент; копий на диске нет — разговор идёт по одной базе.</summary>
        public string? Copy { get; } = copy;

        public CancellationTokenSource Timeout { get; } = new();

        public AgentRequest? Request { get; set; }

        /// <summary>Ответ оборвал оператор, а не пятиминутное ожидание: в переписке это не сбой.</summary>
        public bool Stopped { get; set; }

        /// <summary>Процесс кончился: реплика в его очередь уже не идёт. Меняется только под блокировкой разговора.</summary>
        public bool Ended { get; set; }

        /// <summary>Нынешняя реплика: не прочтённую агентом получает новый.</summary>
        public string? Said { get; set; }

        /// <summary>
        /// Процесс поднят ради нынешней реплики и ещё на неё не ответил: не прочтёт он её — нового ради неё уже не
        /// будет, и сбой встаёт в переписку. Так незапустившийся агент не поднимается без конца.
        /// </summary>
        public bool Raised { get; set; } = true;
    }
}

public static class AskEndpoints
{
    public const string Claude = "claude";

    /// <summary>
    /// Раскладку базы агент иначе угадывает: название проекта, например, ищет в README. Раскладка — кита формата 6
    /// (BaseLayout): общее знание в корне, своё у оператора — личный репозиторий local\me, а people\&lt;имя&gt; —
    /// выложенное для коллег.
    /// </summary>
    internal static string SystemPrompt(string? operatorName) => $"""
        Ты разговариваешь с оператором о проекте по его базе знаний agents-kit — это текущий каталог.
        Что где лежит: product.md — что за система, его заголовок — название проекта; team.md — правила команды
        для любого агента проекта; decisions/*.md — решения по областям. {Own(operatorName)} — его личный репозиторий local/me/ со своим git: autonomy.md — рамки агента у него,
        flow/scenarios.md — сценарии, как ведут задачу, и flow/stages/*.md — их этапы, agents/*.md — исполнители,
        backlog.md — записи бэклога, work/<машина>/*.md — память задач в работе, artifacts/ — их файлы.
        Рядом с каждой памятью work/<машина>/<имя памяти>/flow/ — копия сценария задачи с этапами, снятая при взятии:
        задача идёт по ней, а не по нынешнему flow/.
        В people/<имя>/ — флоу и исполнители, которые операторы выложили для коллег: агент по ним не работает,
        свой флоу оператор правит в local/me/.
        Только читай файлы, ничего не меняй. Отвечай по-русски, коротко и по делу, называя файлы, на которых
        стоит ответ. Оператор переспрашивает и уточняет: помни, о чём шёл разговор.
        """;

    // Оператор не назван или база не читается панелью — имя не выдумывается.
    private static string Own(string? operatorName) => operatorName is null
        ? "Своё у оператора этого компьютера"
        : $"Своё у оператора этого компьютера, {operatorName},";

    /// <summary>
    /// Страницы руководства панели: сборка кладёт их рядом с exe, и в запуске для разработки — тоже (csproj).
    /// </summary>
    public static string GuideDir => Path.Combine(AppContext.BaseDirectory, "guide");

    /// <summary>
    /// Без копии агент знает только базу; с копией ему названо, где код проекта; с руководством — где страницы
    /// о самой панели.
    /// </summary>
    internal static string Prompt(string? operatorName, string? copyPath, string? guidePath = null)
    {
        var prompt = SystemPrompt(operatorName);
        if (copyPath is not null)
            prompt = $"""
                {prompt}
                Код проекта — в каталоге {copyPath}: это рабочая копия проекта, её тоже только читай. Вопрос о коде
                проверяй по самому коду, а не по пересказу в базе.
                """;
        if (guidePath is not null)
            prompt = $"""
                {prompt}
                Разговор идёт в панели agents-kit-web, и оператор спрашивает и о ней самой: что в каком разделе, как что
                сделать, что значит статус или надпись. Руководство оператора по панели — в каталоге {guidePath}:
                start.md — с чего начать и словарь, header.md — шапка панели и разговор с тобой, остальные страницы —
                по странице на раздел панели, заголовок страницы — название раздела. На вопросы о панели отвечай
                по этим страницам, тоже только читая.
                """;
        return prompt;
    }

    public static void MapAskEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ask/bases", (BasesStore bases) =>
            bases.List().Select(b => new AskBase(b, ProjectName.Of(b))).ToList());

        // Копии проекта, чей код может читать агент разговора: основная первой — её окно и выбирает.
        app.MapGet("/api/ask/copies", async (string? @base, BasesStore bases, CancellationToken cancellationToken) =>
        {
            var basePath = Configured(bases, @base);
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            return Results.Ok(await CopiesAsync(basePath, cancellationToken));
        });

        // Разговор держит панель: POST его заводит и отдаёт сводку, а переписку окно читает потоком просьбы.
        app.MapPost("/api/ask", async (
            AskRequest request, BasesStore bases, AskConversations conversations, CancellationToken cancellationToken) =>
        {
            // Агент запускается только в базе из списка панели: путь запроса сверяется со списком.
            var basePath = Configured(bases, request.Base);
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Question))
                return Results.BadRequest();

            // Копия — только из копий этой базы на диске: запрос не должен уметь подать агенту чужой каталог.
            string? copyPath = null;
            if (request.Copy is not null)
            {
                var copies = await CopiesAsync(basePath, cancellationToken);
                copyPath = copies.FirstOrDefault(c => BasesStore.SamePath(c.Path, request.Copy))?.Path;
                if (copyPath is null)
                    return Results.NotFound();
            }

            return Results.Ok(conversations.Start(basePath, copyPath, request.Question.Trim()));
        });

        // Следующая реплика идёт в тот же разговор: база и агент у него свои, менять их не с чего.
        app.MapPost("/api/ask/reply", (AskReply reply, AskConversations conversations) =>
        {
            if (string.IsNullOrWhiteSpace(reply.Text))
                return Results.BadRequest();

            return conversations.Reply(reply.Text.Trim()) switch
            {
                AskReplied.Sent => Results.NoContent(),
                AskReplied.Answering => Results.Conflict(),
                _ => Results.NotFound(),
            };
        });

        // «Отменить» обрывает нынешний ответ, а не весь разговор: переписка остаётся у оператора на экране.
        app.MapPost("/api/ask/stop", (AskConversations conversations) =>
            conversations.Stop() ? Results.NoContent() : Results.NotFound());
    }

    private static string? Configured(BasesStore bases, string? requested) =>
        requested is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, requested));

    private static async Task<List<PerformerCopy>> CopiesAsync(string basePath, CancellationToken cancellationToken) =>
        (await PerformersEndpoints.CopiesAsync(basePath, cancellationToken)).OrderByDescending(c => c.Main).ToList();
}
