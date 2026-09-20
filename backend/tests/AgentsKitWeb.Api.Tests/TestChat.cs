using System.Diagnostics;
using System.Threading.Channels;
using AgentsKitWeb.Api.Ask;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Заглушка живого агента разговора: на каждую реплику выдаёт свой набор строк и ждёт следующей, как настоящий
/// процесс. Настоящий claude в прогоне не запускается — проверяется, как панель его зовёт и читает вывод.
/// </summary>
public sealed class TestChat : IAgentChat
{
    private readonly TaskCompletionSource _cancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Строки агента на каждую реплику по порядку: первая — на первую, вторая — на вторую.</summary>
    public IReadOnlyList<IReadOnlyList<string>> Answers { get; set; } = [];

    public AgentExit Exit { get; set; } = new(0, "");

    public Func<int, Task> BeforeLine { get; set; } = _ => Task.CompletedTask;

    /// <summary>Сколько реплик процесс переживает: дальше он кончается, как сорвавшийся агент.</summary>
    public int? StopAfter { get; set; }

    public List<ProcessStartInfo> Starts { get; } = [];

    public List<string> Input { get; } = [];

    public bool Cancelled => _cancelled.Task.IsCompleted;

    public async Task<bool> CancelledWithin(TimeSpan timeout)
    {
        try
        {
            await _cancelled.Task.WaitAsync(timeout);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    public async Task<AgentExit> RunAsync(
        ProcessStartInfo startInfo,
        ChannelReader<string> replies,
        Func<string, Task> onLine,
        CancellationToken cancellationToken)
    {
        Starts.Add(startInfo);
        if (StopAfter == 0)
            return Exit;

        try
        {
            var answered = 0;
            await foreach (var reply in replies.ReadAllAsync(cancellationToken))
            {
                Input.Add(reply);
                var lines = Input.Count <= Answers.Count ? Answers[Input.Count - 1] : [];
                for (var i = 0; i < lines.Count; i++)
                {
                    await BeforeLine(i).WaitAsync(cancellationToken);
                    await onLine(lines[i]);
                }
                if (++answered == StopAfter)
                    break;
            }
            return Exit;
        }
        catch (OperationCanceledException)
        {
            _cancelled.TrySetResult();
            throw;
        }
    }
}
