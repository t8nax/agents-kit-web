using System.Diagnostics;
using System.Text;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Health;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Reports;

/// <summary>
/// Почему отчёт о флоу не строится. Kind: kit — кит не найден или в его справке нет требований; health — во флоу ошибки
/// сверки, раздел ведёт в «Проблемы баз»; flow — у проекта нет сценариев.
/// </summary>
public sealed record ReportBlock(string Kind, string Reason);

/// <summary>
/// Событие разбора флоу, одной строкой NDJSON. Type: step — ход работы агента (Text); reported — отчёт записан, раздел
/// перечитывает его; error — отчёта нет (Text — почему, Output — что вернул агент).
/// </summary>
public sealed record FlowReportEvent(string Type, string Text, string? Output = null) : IAgentEvent;

/// <summary>
/// Разбор флоу проекта Чудо-Юдо. Агент только читает и возвращает находки одним блоком JSON; баллы считает и отчёт пишет
/// панель. Форму флоу разбор не проверяет — это сверка кита, и с её ошибками во флоу он не строится — решения оператора на B-270.
/// </summary>
public sealed class FlowReports(
    ReportsStore store, HealthMonitor health, IAgentProcess agent, AgentRequests requests, BasesStore bases, TimeProvider time)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);

    public ReportBlock? Blocked(string basePath) => Blocked(basePath, out _);

    private ReportBlock? Blocked(string basePath, out FlowRequirements? requirements)
    {
        requirements = FlowRequirements.Read(bases.Kit(), out var error);
        if (requirements is null)
            return new ReportBlock("kit", error);
        return FlowErrors(health.Snapshot, basePath) > 0
            ? new ReportBlock("health", "Во флоу проекта есть ошибки сверки. Отчёт строится, когда они исправлены.")
            : null;
    }

    /// <summary>
    /// Ошибки сверки кита во флоу базы: находки уровня error в файлах flow/ личного репозитория. Ошибки вне флоу разбору не
    /// мешают — решение оператора на B-270.
    /// </summary>
    public static int FlowErrors(HealthSnapshot snapshot, string basePath) =>
        snapshot.Bases.FirstOrDefault(b => BasesStore.SamePath(b.Base, basePath))?.Problems
            .Count(problem => problem.Severity == "error" && InFlow(problem.File)) ?? 0;

    private static bool InFlow(string? file) =>
        file is not null && file.Replace('\\', '/').Split('/').Contains("flow");

    /// <summary>Разбор идёт — его и видит раздел, пока он не кончился.</summary>
    public AgentRequest? Running => requests.Of(AgentRequests.Report) is { Finished: false } request ? request : null;

    /// <summary>Заводит разбор флоу базы. Не строится — причина; иначе просьба, ход которой раздел читает потоком.</summary>
    public async Task<(AgentRequest? Started, ReportBlock? Block)> StartAsync(string basePath, CancellationToken cancellationToken)
    {
        if (Blocked(basePath, out var requirements) is { } block)
            return (null, block);
        if (await FlowMaterial.ReadAsync(basePath, cancellationToken) is not { } material)
            return (null, NoFlow);

        var project = ProjectName.Of(basePath);
        var started = requests.Start(
            AgentRequests.Report, basePath, project, $"Разбор флоу проекта «{project}»",
            async (reporting, token) =>
                reporting.Write(await RunAsync(basePath, project, requirements!, material, reporting, token)));
        return (started, null);
    }

    public static readonly ReportBlock NoFlow =
        new("flow", "У проекта нет сценариев. Отчёт строится по флоу, а флоу пишут в разделе «Флоу».");

    private async Task<FlowReportEvent> RunAsync(
        string basePath,
        string project,
        FlowRequirements requirements,
        FlowMaterial material,
        AgentRequest reporting,
        CancellationToken aborted)
    {
        var stream = new ClaudeStream(basePath);
        AskEvent? result = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(
                StartInfo(basePath, material.Personal, project),
                Input(requirements, material),
                line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            reporting.Write(new FlowReportEvent("step", e.Text));
                        else
                            result = e;
                    }
                    return Task.CompletedTask;
                },
                timeout.Token);
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return new FlowReportEvent("error", $"{AgentRequests.AgentName} не закончил разбор за десять минут и остановлен.");
        }

        if (result is null)
            return exit.ExitCode is null
                ? new FlowReportEvent("error", "Claude Code не запустился.", exit.Error)
                : new FlowReportEvent(
                    "error",
                    $"{AgentRequests.AgentName} завершился без ответа.",
                    FlowRewriteEndpoints.Shorten(string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0))));
        if (result.Type == "error")
            return new FlowReportEvent("error", result.Text, FlowRewriteEndpoints.Shorten(result.Output));

        if (FlowReportAnswer.Parse(result.Text, requirements, out var error) is not { } parsed)
            return new FlowReportEvent("error", $"Панель не приняла ответ {AgentRequests.AgentName}: {error}.", FlowRewriteEndpoints.Shorten(result.Text));

        // Отменённый разбор отчёта не трогает: прежний остаётся как был.
        aborted.ThrowIfCancellationRequested();
        var now = time.GetLocalNow();
        store.SaveReport(basePath, ReportsStore.FlowKind, new FlowReport(
            now, now, material.Fingerprint, requirements.Items, parsed.Findings, parsed.Discussions));
        return new FlowReportEvent("reported", "Отчёт построен.");
    }

    /// <summary>
    /// Агент работает в каталоге базы и только читает: отчёт пишет панель. Флоу, субагенты и требования приходят ему
    /// в stdin; остальное знание базы — решения, продукт, правила команды — он дочитывает сам.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string personal, string project)
    {
        var systemPrompt = $$"""
            Ты разбираешь флоу проекта «{{project}}» для оператора веб-панели agents-kit: проверяешь, выполняются ли в нём
            требования к флоу из справки кита. Спросить оператора нельзя.
            Флоу — сценарии flow/scenarios.md и этапы flow/stages/*.md личного репозитория оператора {{personal}}, —
            описания его субагентов из agents/ и требования придут одним сообщением. Базу знаний проекта {{basePath}} можно
            читать: в ней решения decisions/, product.md и team.md — по ним видно, не пересказывает ли флоу устройство
            системы или правила команды.
            Форму флоу не проверяй: её проверяет сверка кита. Проверяй смысл — каждое требование по всему флоу.
            Находка — одно место во флоу, где нарушено требование. Если одно место нарушает два требования, это одна находка
            с обоими номерами. Не выдумывай находок: где ошибки нет, а есть выбор устройства, это вопрос для обсуждения.
            Ответ верни одним блоком JSON и ничего больше:
            {"findings":[{"requirements":["П1"],"place":"…","quotes":[{"where":"…","text":"…"}],"why":"…","fix":"…"}],
             "discussions":[{"title":"…","place":"…","now":"…","for":"…","against":"…"}]}
            requirements — номера нарушенных требований из списка; place — этап, сценарий или субагент, где проблема, его
            названием; quotes — где именно и что там написано, дословно; why — почему это плохо, через последствие для
            работы; fix — что сделать, конкретно. У вопроса для обсуждения: title — вопрос, place — где, now — как сейчас,
            for — довод за перемену, against — довод за то, чтобы оставить.
            Тексты пиши официальным стилем: полными предложениями, без жаргона и разговорных слов. Номеров требований
            в текстах не упоминай и слова «инвариант» не употребляй: говори о свойстве флоу и его последствии.
            Файлы менять нельзя.
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, basePath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", systemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        AgentProcess.AddAutoMode(startInfo);
        return startInfo;
    }

    /// <summary>Требования кита, флоу и субагенты оператора уходят агенту в stdin.</summary>
    public static string Input(FlowRequirements requirements, FlowMaterial material) => new StringBuilder()
        .Append("Требования к флоу из справки кита:\n\n").Append(requirements.Section)
        .Append("\n\nФлоу оператора, файлы flow/ его личного репозитория:\n\n").Append(material.Flow)
        .Append("\n\nСубагенты оператора, файлы agents/ его личного репозитория:\n\n")
        .Append(material.Agents.Length > 0 ? material.Agents : "субагентов нет.")
        .ToString();
}
