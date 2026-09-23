using System.Diagnostics;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Ask;

/// <summary>Событие просьбы, уходящее окну строкой NDJSON. Тип, отличный от «step», — итог просьбы.</summary>
public interface IAgentEvent
{
    string Type { get; }
}

/// <summary>Сбой, о котором не сказал ни один из видов просьбы: окно читает его, как свою ошибку.</summary>
public sealed record AgentFault(string Text) : IAgentEvent
{
    public string Type => "error";
}

/// <summary>
/// Просьба в списке панели: по ней шапка показывает, чем занят агент и готов ли итог. Subject — про кого она:
/// имя переписываемого исполнителя, чтобы его просьбу подхватывало окно его правки, а не окно нового (B-80);
/// у разговора по базе — путь копии проекта, чей код читает агент: окно, открытое заново, её и показывает (B-130).
/// Stages — стадии флоу, ушедшие агенту вместе с просьбой: открытое заново окно переписывания показывает их
/// и сличает с ними ответ.
/// </summary>
public sealed record AgentRequestSummary(
    string Kind, string Id, string Base, string Project, string Text, long ElapsedMs, string State,
    string? Subject = null, IReadOnlyList<FlowStage>? Stages = null);

/// <summary>
/// Одна просьба к агенту, живущая в панели. Ход работы копится строками NDJSON: окно читает их с начала,
/// сколько бы раз его ни открывали, и ждёт следующих. Первое событие не «step» — итог: он закрывает просьбу
/// и ждёт оператора, пока тот его не заберёт.
/// </summary>
public sealed class AgentRequest
{
    /// <summary>Сколько текста просьбы показывает список панели: запись в бэклог бывает в несколько абзацев.</summary>
    private const int TextLimit = 200;

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Ход и ответ агента почти весь по-русски: без этого каждая буква уходит escape-последовательностью.
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };

    private readonly object _gate = new();
    private readonly List<string> _lines = [];
    private readonly CancellationTokenSource _cancel = new();
    private readonly Stopwatch _elapsed = Stopwatch.StartNew();
    private TaskCompletionSource _written = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private string _state = Running;
    private bool _removed;
    private bool _working = true;

    public const string Running = "running";
    public const string Done = "done";
    public const string Failed = "failed";

    public AgentRequest(
        string kind, string basePath, string project, string text, bool continues = false, string? subject = null,
        IReadOnlyList<FlowStage>? stages = null)
    {
        Kind = kind;
        Subject = subject;
        Stages = stages;
        Base = basePath;
        Project = project;
        Text = text;
        Continues = continues;
    }

    /// <summary>
    /// Просьба-переписка: итог закрывает реплику, а не просьбу — разговор ждёт следующей и убирается только
    /// кнопкой «Новая переписка» или уходом панели (B-79).
    /// </summary>
    public bool Continues { get; }

    public string Kind { get; }

    public string Id { get; } = Guid.NewGuid().ToString("N");

    public string Base { get; }

    public string Project { get; }

    public string Text { get; }

    /// <summary>
    /// Про кого просьба: имя переписываемого исполнителя; null — просьба не про заведённого. У разговора по базе —
    /// путь копии проекта, чей код читает агент; null — разговор идёт по одной базе.
    /// </summary>
    public string? Subject { get; }

    /// <summary>Стадии флоу, ушедшие агенту с просьбой переписать их; у других просьб — null.</summary>
    public IReadOnlyList<FlowStage>? Stages { get; }

    public CancellationToken Token => _cancel.Token;

    public bool Finished
    {
        get
        {
            lock (_gate)
                return _state != Running;
        }
    }

    /// <summary>Работа ещё идёт: у переписки это значит, что живой процесс агента ждёт следующей реплики.</summary>
    public bool Working
    {
        get
        {
            lock (_gate)
                return _working;
        }
    }

    public AgentRequestSummary Summary
    {
        get
        {
            lock (_gate)
                return new AgentRequestSummary(
                    Kind,
                    Id,
                    Base,
                    Project,
                    Text.Length > TextLimit ? Text[..TextLimit] + "…" : Text,
                    (long)_elapsed.Elapsed.TotalMilliseconds,
                    _state,
                    Subject,
                    Stages);
        }
    }

    /// <summary>
    /// Пишет событие в просьбу. Событие не «step» закрывает её: агенту больше нечего сказать. У переписки оно
    /// закрывает только реплику — следующая открывает её снова.
    /// </summary>
    public void Write(IAgentEvent e)
    {
        var line = JsonSerializer.Serialize(e, e.GetType(), JsonOptions);
        lock (_gate)
        {
            if (_removed || (!Continues && _state != Running))
                return;
            _lines.Add(line);
            if (e.Type is not ("step" or "note"))
            {
                _state = e.Type == "error" ? Failed : Done;
                _elapsed.Stop();
            }
            Pulse();
        }
    }

    /// <summary>Реплика оператора: она встаёт в переписку событием и снова пускает просьбу в работу.</summary>
    public void Reply(IAgentEvent e)
    {
        var line = JsonSerializer.Serialize(e, e.GetType(), JsonOptions);
        lock (_gate)
        {
            if (_removed)
                return;
            _lines.Add(line);
            _state = Running;
            _working = true;
            _elapsed.Restart();
            Pulse();
        }
    }

    /// <summary>Работа кончилась. Итога так и не было — окну нечего ждать, и просьба закрывается неудачей.</summary>
    public void Finish()
    {
        lock (_gate)
        {
            _working = false;
            if (_state == Running)
            {
                _state = Failed;
                _elapsed.Stop();
            }
            Pulse();
        }
    }

    public void Cancel()
    {
        lock (_gate)
            _removed = true;
        _cancel.Cancel();
        Finish();
    }

    /// <summary>
    /// Строки с указанной, признак конца и ожидание следующих. Окно читает с нуля при каждом открытии:
    /// ход, пришедший без него, тем же и виден.
    /// </summary>
    public (IReadOnlyList<string> Lines, bool Finished, Task Written) Since(int from)
    {
        lock (_gate)
        {
            var lines = from < _lines.Count ? _lines[from..] : [];
            // Поток переписки закрывает только уход самой просьбы: между репликами окно ждёт следующую в нём же.
            var finished = Continues ? _removed : _state != Running;
            return (lines, finished, _written.Task);
        }
    }

    private void Pulse()
    {
        var written = _written;
        _written = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        written.TrySetResult();
    }
}

/// <summary>
/// Просьбы к агенту, которые держит панель. Окно их только показывает: закрытое окно агента не трогает,
/// и вернувшийся оператор видит ту же работу. Разом идёт по одной просьбе каждого вида — решение оператора
/// на B-52; новая просьба того же вида останавливает прежнюю.
/// </summary>
public sealed class AgentRequests
{
    /// <summary>Имя агента панели, выбранное оператором: им зовут все три просьбы — приёмка B-52.</summary>
    public const string AgentName = "Чудо-Юдо";

    public const string Ask = "ask";
    public const string Backlog = "backlog";
    public const string Flow = "flow";
    public const string Performer = "performer";

    public static readonly IReadOnlyList<string> Kinds = [Ask, Backlog, Flow, Performer];

    private readonly object _gate = new();
    private readonly Dictionary<string, AgentRequest> _requests = new(StringComparer.Ordinal);

    public AgentRequest Start(
        string kind,
        string basePath,
        string project,
        string text,
        Func<AgentRequest, CancellationToken, Task> work,
        bool continues = false,
        string? subject = null,
        IReadOnlyList<FlowStage>? stages = null)
    {
        var request = new AgentRequest(kind, basePath, project, text, continues, subject, stages);
        lock (_gate)
        {
            if (_requests.Remove(kind, out var previous))
                previous.Cancel();
            _requests[kind] = request;
        }

        Run(request, work);
        return request;
    }

    /// <summary>
    /// Поднимает работу для просьбы, которая уже живёт: разговор продолжается тем же списком реплик, хотя
    /// прежний процесс агента кончился.
    /// </summary>
    public void Run(AgentRequest request, Func<AgentRequest, CancellationToken, Task> work)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await work(request, request.Token);
            }
            catch (OperationCanceledException)
            {
                // Оператор отменил просьбу: процесс агента уже убит, писать итог некому.
            }
            catch (Exception e)
            {
                request.Write(new AgentFault($"Панель не довела просьбу до конца: {e.Message}"));
            }
            finally
            {
                request.Finish();
            }
        });
    }

    public AgentRequest? Of(string kind)
    {
        lock (_gate)
            return _requests.GetValueOrDefault(kind);
    }

    /// <summary>Убирает просьбу: идущую — вместе с агентом, законченную — вместе с её итогом.</summary>
    public bool Remove(string kind)
    {
        AgentRequest? request;
        lock (_gate)
            if (!_requests.Remove(kind, out request))
                return false;

        request.Cancel();
        return true;
    }

    public IReadOnlyList<AgentRequestSummary> List()
    {
        lock (_gate)
            return Kinds.Where(_requests.ContainsKey).Select(kind => _requests[kind].Summary).ToList();
    }
}
