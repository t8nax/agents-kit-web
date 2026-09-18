using System.Diagnostics;
using AgentsKitWeb.Api.Ask;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Гашение фоновой сессии: панель просит сам claude остановить её по короткому id. Гасят отсюда двое —
/// оператор пунктом строки перечня и фоновая уборка отработавших сессий задач, — и просят они одинаково.
/// </summary>
public static class SessionStop
{
    /// <summary>Столько ждут гашения: claude stop только просит сессию завершиться и сам не работает долго.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    /// <summary>`claude stop &lt;id&gt;` в каталоге сессии; каталога уже нет — в каталоге профиля.</summary>
    public static ProcessStartInfo StartInfo(AgentSession session)
    {
        var directory = Directory.Exists(session.Cwd)
            ? session.Cwd
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, directory);
        startInfo.ArgumentList.Add("stop");
        startInfo.ArgumentList.Add(session.JobId!);
        return startInfo;
    }

    /// <summary>
    /// Гасит сессию и говорит, чем это кончилось: null — погасла, иначе — что сказал claude. Отмена
    /// переданным токеном пробрасывается: её просит тот, кто позвал, а не сам claude.
    /// </summary>
    public static async Task<string?> StopAsync(
        IAgentProcess agent, AgentSession session, CancellationToken cancellationToken)
    {
        var output = new List<string>();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);

        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(StartInfo(session), "", line =>
            {
                output.Add(line);
                return Task.CompletedTask;
            }, timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return "claude не погасил сессию за полминуты";
        }

        if (exit.ExitCode == 0)
            return null;

        var said = string.Join("\n", output).Trim();
        var text = new[] { exit.Error, said }.FirstOrDefault(t => t.Length > 0);
        return text ?? $"claude завершился с кодом {exit.ExitCode} и ничего не сказал";
    }
}
