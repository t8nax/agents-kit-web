using System.Diagnostics;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Заведение фоновой сессии claude — общее для запуска задачи и для сессии не под задачу. Сессия переживает
/// панель: оператор входит в неё «claude attach &lt;id&gt;» и гасит «claude stop &lt;id&gt;». Прав панель
/// не навязывает — сессия идёт в обычном режиме оператора.
/// </summary>
public static partial class BackgroundSession
{
    /// <summary>Заведение фоновой сессии — не разговор с агентом: дольше этого оно не идёт.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    // Короткий id фоновой сессии в выводе claude: «backgrounded · 7339dced».
    [GeneratedRegex(@"backgrounded[^0-9a-f]*(?<id>[0-9a-f]{6,})")]
    private static partial Regex Backgrounded { get; }

    // Цвета claude пишет и в перенаправленный вывод, а «[36m» перед id состоит из тех же знаков, что и id:
    // без снятия последовательностей id не разбирается.
    [GeneratedRegex("\\[[0-9;]*[a-zA-Z]")]
    private static partial Regex AnsiCodes { get; }

    /// <summary>
    /// `claude --bg -- &lt;просьба&gt;` в каталоге копии. Просьба уходит после «--»: текст, начатый с «-»,
    /// claude принял бы за флаг. Просьбы нет — сессия заводится простаивающей и ждёт оператора.
    /// </summary>
    public static ProcessStartInfo StartInfo(string copyPath, string? prompt = null)
    {
        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath);
        startInfo.ArgumentList.Add("--bg");
        if (!string.IsNullOrWhiteSpace(prompt))
        {
            startInfo.ArgumentList.Add("--");
            startInfo.ArgumentList.Add(prompt);
        }
        return startInfo;
    }

    /// <summary>Заводит сессию и возвращает её id из вывода claude; не завелась — чем именно.</summary>
    public static async Task<(string? Session, string? Failure)> StartAsync(
        IAgentProcess agent, ProcessStartInfo startInfo, CancellationToken cancellationToken)
    {
        var output = new List<string>();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);

        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(startInfo, "", line =>
            {
                output.Add(line);
                return Task.CompletedTask;
            }, timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (null, "claude не завёл сессию за две минуты");
        }

        var said = Plain(string.Join("\n", output)).Trim();
        if (exit.ExitCode is null)
            return (null, exit.Error.Length > 0 ? Plain(exit.Error) : "claude не запустился");

        var match = Backgrounded.Match(said);
        if (!match.Success)
        {
            var text = new[] { said, Plain(exit.Error) }.FirstOrDefault(t => t.Length > 0);
            return (null, text ?? $"claude завершился с кодом {exit.ExitCode} и ничего не сказал");
        }
        return (match.Groups["id"].Value, null);
    }

    private static string Plain(string text) => AnsiCodes.Replace(text, "");
}
