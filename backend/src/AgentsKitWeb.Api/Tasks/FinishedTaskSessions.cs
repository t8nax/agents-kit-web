using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tasks;

/// <summary>
/// Гасит сессию задачи, которая своё отработала: задача закрыта — памяти у копии больше нет, — а сессия
/// стоит без дела. Гашение идёт от панели, а не от открытой вкладки: сессия переживает и то и другое,
/// и убирать её за оператором некому — решение оператора на B-68.
///
/// Отработавшая сессия гасится не сразу, а простояв выдержку: реестр не отличает сессию, которая
/// кончила задачу, от той, что ждёт, пока оператор в неё войдёт, и выдержка даёт ему время войти.
/// </summary>
public sealed class FinishedTaskSessions(
    BasesStore bases,
    AgentSessions sessions,
    TaskSessions tasks,
    StartedTasks started,
    IAgentProcess agent,
    TimeProvider time,
    IConfiguration configuration,
    ILogger<FinishedTaskSessions> logger) : BackgroundService
{
    /// <summary>С какого времени сессия копии числится отработавшей; сессия сменилась — отсчёт заново.</summary>
    private readonly Dictionary<string, (string Session, DateTimeOffset Since)> _finished =
        new(StringComparer.OrdinalIgnoreCase);

    private TimeSpan Interval => TimeSpan.FromSeconds(configuration.GetValue("FinishedSessionIntervalSeconds", 30));

    /// <summary>Сколько сессия стоит отработавшей, прежде чем панель её погасит.</summary>
    private TimeSpan Delay => TimeSpan.FromSeconds(configuration.GetValue("FinishedSessionDelaySeconds", 300));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await SweepAsync(stoppingToken);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogError(e, "Уборка отработавших сессий упала");
                }
                await Task.Delay(Interval, time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>
    /// Один круг уборки: отмечает отработавшие сессии задач и гасит те, что простояли выдержку.
    /// </summary>
    public async Task SweepAsync(CancellationToken cancellationToken)
    {
        // Живых фоновых сессий нет — гасить нечего, и копии ради этого собирать незачем: сбор ходит в git.
        if (!sessions.Live().Any(session => session.InBackground))
        {
            _finished.Clear();
            return;
        }

        var now = time.GetUtcNow();
        var rows = await WorkspaceCollector.CollectAsync(bases.List(), cancellationToken);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var row in rows.Where(row => row.Error is null))
        {
            var key = WorkspaceCollector.Normalize(row.Path);
            // Сессию панель знает только по своему запуску задачи: заведённую оператором она не гасит.
            var id = tasks.SessionIn(row.Path);
            var session = sessions.BackgroundIn(row.Path, id);
            if (session is null || id is null || !Finished(row, session))
                continue;

            seen.Add(key);
            if (!_finished.TryGetValue(key, out var since) || since.Session != id)
            {
                _finished[key] = (id, now);
                continue;
            }
            if (now - since.Since < Delay)
                continue;

            // Отсчёт снимается в любом случае: не погасла — панель попробует снова, отстояв выдержку заново.
            _finished.Remove(key);
            seen.Remove(key);
            await StopAsync(row.Path, session, cancellationToken);
        }

        foreach (var key in _finished.Keys.Where(key => !seen.Contains(key)).ToList())
            _finished.Remove(key);
    }

    /// <summary>
    /// Сессия отработала: её задача закрыта — памяти у копии нет, и копия числится свободной, — а сама
    /// сессия стоит без дела. Работающая сессия и копия, которая ждёт ответа оператора или ещё ведёт
    /// задачу, не тронуты.
    /// </summary>
    private static bool Finished(WorkspaceRow row, AgentSession session) =>
        row.Status == WorkspaceStatus.Free && session.State == SessionState.Idle;

    private async Task StopAsync(string copyPath, AgentSession session, CancellationToken cancellationToken)
    {
        var failure = await SessionStop.StopAsync(agent, session, cancellationToken);
        if (failure is not null)
        {
            // Сессия остаётся в перечне, и оператор гасит её сам — панель только говорит, почему не вышло.
            logger.LogWarning("Сессия {Session} не погашена: {Failure}", session.JobId, failure);
            return;
        }

        // Копия снова готова к запуску задачи: отметка о запуске держала её занятой, пока шла эта сессия.
        started.Forget(copyPath);
        logger.LogInformation("Сессия {Session} копии {Copy} отработала и погашена", session.JobId, copyPath);
    }
}
