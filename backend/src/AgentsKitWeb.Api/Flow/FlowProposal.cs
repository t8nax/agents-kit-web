using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Ask;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Правка этапа в переписке. Of — название этапа на экране; null — этап новый. Stage null — этап удаляется.</summary>
public sealed record StageChange(string? Of, FlowStage? Stage);

/// <summary>Правка сценария в переписке. Of — имя сценария на экране; null — сценарий новый. Flow null — удаляется.</summary>
public sealed record ScenarioChange(string? Of, NamedFlow? Flow);

/// <summary>
/// Правки, до которых договорились в переписке о флоу, — всё, что агент предложил за разговор, в последнем виде:
/// одна правка на сценарий и этап. Записывает их панель по «Принять правки» (B-242).
/// </summary>
public sealed record FlowProposal(IReadOnlyList<ScenarioChange> Scenarios, IReadOnlyList<StageChange> Stages)
{
    public static readonly FlowProposal Empty = new([], []);

    public bool Equals(FlowProposal? other) =>
        other is not null && Scenarios.SequenceEqual(other.Scenarios) && Stages.SequenceEqual(other.Stages);

    public override int GetHashCode() => HashCode.Combine(Scenarios.Count, Stages.Count);
}

/// <summary>Сколько сценариев и этапов тронул один ответ агента: строка «В изменениях: …» под ним.</summary>
public sealed record FlowChanged(int Scenarios, int Stages);

/// <summary>Ответ агента, разобранный на слова и правки. Error задан — правки не приняты, Proposal прежний.</summary>
public sealed record FlowAnswer(string Said, FlowProposal Proposal, FlowChanged? Changed, string? Error);

/// <summary>
/// Разбор правок агента и наложение их на флоу раздела. Ответ — слова, а за ними блоки под строками «=== …»:
/// этап и сценарий переписанный, новый или удалённый. Блоки читаются тем же чтением, каким панель читает файлы флоу
/// с диска, а флоу с правками сверяется правилами кита: оператор видит только то, что запись потом примет.
/// </summary>
public static partial class FlowProposals
{
    public const string NewStage = "новый этап";
    public const string NewScenario = "новый сценарий";

    // Строка перед блоком: «=== этап «Ревью»», «=== новый сценарий», «=== удалить этап «Ревью»».
    [GeneratedRegex(@"^===\s*(?<head>.*?)\s*$")]
    private static partial Regex BlockLine { get; }

    [GeneratedRegex(@"^(?<delete>удалить\s+)?(?<what>этап|сценарий)\s*«(?<name>[^»]*)»$")]
    private static partial Regex NamedHead { get; }

    /// <summary>Флоу раздела с правками: этапы на месте прежних, новые — в конце; переименованный этап — и в пунктах.</summary>
    public static (List<FlowStage> Stages, List<NamedFlow> Flows) Apply(
        IReadOnlyList<FlowStage> stages, IReadOnlyList<NamedFlow> flows, FlowProposal proposal)
    {
        var result = stages.ToList();
        var renamed = new Dictionary<string, string>();
        foreach (var change in proposal.Stages)
        {
            var at = change.Of is null ? -1 : result.FindIndex(s => FlowFolder.Key(s.Title) == FlowFolder.Key(change.Of));
            if (at < 0)
            {
                if (change.Stage is not null)
                    result.Add(change.Stage);
                continue;
            }
            if (change.Stage is null)
            {
                result.RemoveAt(at);
                continue;
            }
            if (FlowFolder.Key(change.Stage.Title) != FlowFolder.Key(result[at].Title))
                renamed[FlowFolder.Key(result[at].Title)] = change.Stage.Title;
            result[at] = change.Stage with { Slug = result[at].Slug };
        }

        var named = flows.ToList();
        foreach (var change in proposal.Scenarios)
        {
            var at = change.Of is null ? -1 : named.FindIndex(f => FlowFolder.Key(f.Name) == FlowFolder.Key(change.Of));
            if (at < 0)
            {
                if (change.Flow is not null)
                    named.Add(change.Flow);
            }
            else if (change.Flow is null)
                named.RemoveAt(at);
            else
                named[at] = change.Flow;
        }

        // Пункт, названный прежним именем переименованного этапа, идёт за этапом — как ручное переименование в разделе.
        var titles = result.Select(s => FlowFolder.Key(s.Title)).ToHashSet();
        string Follow(string stage) =>
            !titles.Contains(FlowFolder.Key(stage)) && renamed.TryGetValue(FlowFolder.Key(stage), out var now) ? now : stage;
        return (result, named.Select(f => f with
        {
            Entries = f.Entries.Select(e => new FlowEntry(
                Follow(e.Stage),
                FlowFolder.Returns(e).Select(r => r with { Stage = Follow(r.Stage) }).ToList())).ToList(),
        }).ToList());
    }

    /// <summary>
    /// Правки, которых на экране ещё нет: записанное оператором уходит из них само. Правка, которую экран уже держит,
    /// и удаление того, чего на экране уже нет, убираются.
    /// </summary>
    public static FlowProposal Rebase(IReadOnlyList<FlowStage> stages, IReadOnlyList<NamedFlow> flows, FlowProposal proposal) =>
        new(
            proposal.Scenarios.Where(c => c.Flow is null
                ? c.Of is not null && flows.Any(f => FlowFolder.Key(f.Name) == FlowFolder.Key(c.Of))
                : !flows.Contains(c.Flow)).ToList(),
            proposal.Stages.Where(c => c.Stage is null
                ? c.Of is not null && stages.Any(s => FlowFolder.Key(s.Title) == FlowFolder.Key(c.Of))
                : !stages.Any(s => s with { Slug = null } == c.Stage with { Slug = null })).ToList());

    /// <summary>
    /// Ответ агента: слова до первого блока и правки, наложенные на прежние. Блоков нет — это вопрос или рассуждение,
    /// и правки остаются как были. Блок, который кит не примет, или флоу, который с правками не сойдётся, — ошибка,
    /// и прежние правки тоже остаются.
    /// </summary>
    public static FlowAnswer Take(
        string answer, IReadOnlyList<FlowStage> stages, IReadOnlyList<NamedFlow> flows, FlowProposal proposal)
    {
        var (said, blocks) = Split(answer);
        if (blocks.Count == 0)
            return new FlowAnswer(said, proposal, null, null);

        FlowAnswer Reject(string error) => new(said, proposal, null, error);

        var stageChanges = proposal.Stages.ToList();
        var scenarioChanges = proposal.Scenarios.ToList();
        var touchedStages = new HashSet<string>();
        var touchedScenarios = new HashSet<string>();

        foreach (var (head, text) in blocks)
        {
            var (now, _) = Apply(stages, flows, new FlowProposal(scenarioChanges, stageChanges));
            var match = NamedHead.Match(head);
            var key = FlowFolder.Key(head);

            if (key == NewStage || match is { Success: true } && match.Groups["what"].Value == "этап")
            {
                var name = match.Success ? match.Groups["name"].Value.Trim() : null;
                var delete = match.Success && match.Groups["delete"].Success;
                // Этап, правленный раньше в этой переписке, агент зовёт его нынешним названием.
                var earlier = name is null ? -1 : stageChanges.FindIndex(c => c.Stage is not null && FlowFolder.Key(c.Stage.Title) == FlowFolder.Key(name));
                var shown = name is null || earlier >= 0 ? null : stages.FirstOrDefault(s => FlowFolder.Key(s.Title) == FlowFolder.Key(name));
                if (name is not null && (earlier < 0 && shown is null || shown is not null && stageChanges.Any(c => c.Of is not null && FlowFolder.Key(c.Of) == FlowFolder.Key(shown.Title))))
                    return Reject($"{Agent} предложил правку этапа «{name}», которого во флоу нет");

                FlowStage? stage = null;
                if (!delete)
                {
                    var slug = earlier >= 0 ? now.FirstOrDefault(s => FlowFolder.Key(s.Title) == FlowFolder.Key(name!))?.Slug : shown?.Slug;
                    var (read, unread) = FlowFolder.ReadStage(text, slug ?? "");
                    stage = read with { Slug = slug };
                    var label = stage.Title.Length > 0 ? $"«{stage.Title}»" : "без названия";
                    if (unread.Count > 0)
                        return Reject($"Этап {label} вернулся не в форме кита: {unread[0]}");
                    if (FlowFolder.StageProblem(stage) is { } problem)
                        return Reject($"Этап {label} вернулся не в форме кита: {Problem(problem)}");
                }

                if (earlier >= 0)
                {
                    // Этап, заведённый в этой же переписке и удалённый ею, уходит из правок совсем.
                    if (stage is null && stageChanges[earlier].Of is null)
                        stageChanges.RemoveAt(earlier);
                    else
                        stageChanges[earlier] = stageChanges[earlier] with { Stage = stage };
                }
                else
                    stageChanges.Add(new StageChange(shown?.Title, stage));
                touchedStages.Add(FlowFolder.Key(stage?.Title ?? name!));
            }
            else if (key == NewScenario || match is { Success: true } && match.Groups["what"].Value == "сценарий")
            {
                var name = match.Success ? match.Groups["name"].Value.Trim() : null;
                var delete = match.Success && match.Groups["delete"].Success;
                var earlier = name is null ? -1 : scenarioChanges.FindIndex(c => c.Flow is not null && FlowFolder.Key(c.Flow.Name) == FlowFolder.Key(name));
                var shown = name is null || earlier >= 0 ? null : flows.FirstOrDefault(f => FlowFolder.Key(f.Name) == FlowFolder.Key(name));
                if (name is not null && (earlier < 0 && shown is null || shown is not null && scenarioChanges.Any(c => c.Of is not null && FlowFolder.Key(c.Of) == FlowFolder.Key(shown.Name))))
                    return Reject($"{Agent} предложил правку сценария «{name}», которого во флоу нет");

                NamedFlow? flow = null;
                if (!delete)
                {
                    // Пункт адресует этап текстом ссылки: адрес нового этапа агент знать не может.
                    var list = FlowFolder.ParseList(text, new Dictionary<string, string>());
                    if (list.Unread.Count > 0)
                        return Reject($"Сценарий «{name ?? list.Flows.FirstOrDefault()?.Name}» вернулся не в форме кита: {list.Unread[0]}");
                    if (list.Flows.Count != 1 || list.Intro.Length > 0)
                        return Reject($"{Agent} вернул под пометкой «=== {head}» не один раздел сценария «## Имя»");
                    flow = list.Flows[0];
                }

                if (earlier >= 0)
                {
                    if (flow is null && scenarioChanges[earlier].Of is null)
                        scenarioChanges.RemoveAt(earlier);
                    else
                        scenarioChanges[earlier] = scenarioChanges[earlier] with { Flow = flow };
                }
                else
                    scenarioChanges.Add(new ScenarioChange(shown?.Name, flow));
                touchedScenarios.Add(FlowFolder.Key(flow?.Name ?? name!));
            }
            else
                return Reject($"{Agent} вернул блок с пометкой, которую панель не знает: «=== {head}»");
        }

        var next = new FlowProposal(scenarioChanges, stageChanges);
        var (proposedStages, proposedFlows) = Apply(stages, flows, next);
        if (FlowFolder.Validate(proposedStages, proposedFlows) is { } rejection)
            return Reject($"С правками {Agent} флоу не сойдётся с правилами кита: {Rejection(rejection)}");
        return new FlowAnswer(said, next, new FlowChanged(touchedScenarios.Count, touchedStages.Count), null);
    }

    private const string Agent = AgentRequests.AgentName;

    // Ответ по строкам «=== …»: слова до первой пометки и блоки под пометками. Внутри блока строка из одних «=» —
    // текст: так в описании подчёркивают заголовок. Любая другая «=== …» — пометка, и неверную разбор назовёт.
    private static (string Said, List<(string Head, string Text)> Blocks) Split(string answer)
    {
        var said = new List<string>();
        var blocks = new List<(string Head, List<string> Lines)>();
        foreach (var line in answer.Replace("\r\n", "\n").Split('\n'))
        {
            if (BlockLine.Match(line) is { Success: true } block && line.Trim().Trim('=').Length > 0)
                blocks.Add((block.Groups["head"].Value, []));
            else if (blocks.Count > 0)
                blocks[^1].Lines.Add(line);
            else
                said.Add(line);
        }
        // Ограду агент ставит и вокруг каждого блока, и вокруг всех разом: общую он открывает строкой перед первым
        // блоком и закрывает в хвосте последнего — обе не часть ни слов, ни файла.
        var text = string.Join("\n", said).TrimEnd();
        var cut = text.LastIndexOf('\n');
        if (blocks.Count > 0 && text[(cut + 1)..].TrimStart().StartsWith("```", StringComparison.Ordinal))
            text = cut < 0 ? "" : text[..cut].TrimEnd();
        return (text.Trim(), blocks.Select(b => (b.Head, Body(string.Join("\n", b.Lines)))).ToList());
    }

    private static string Body(string text)
    {
        if (text.TrimStart().StartsWith("```", StringComparison.Ordinal))
            return FlowRewriteEndpoints.Unfence(text);
        var trimmed = text.TrimEnd();
        var cut = trimmed.LastIndexOf('\n');
        return trimmed[(cut + 1)..].Trim() == "```" ? trimmed[..Math.Max(cut, 0)] : text;
    }

    private static string Problem(string problem) => problem switch
    {
        "stage-empty-title" => "нет названия",
        "stage-empty-executor" => "не указан исполнитель",
        "stage-empty-output" => "не указан выход",
        "stage-bad-title" => "в названии скобки или кавычки",
        "helpers-not-orchestrator" => "помощники у этапа, который делает не оркестратор",
        _ => "перевод строки в ключе этапа",
    };

    private static string Rejection(FlowFolderRejection rejection)
    {
        var where = (rejection.Flow, rejection.Stage) switch
        {
            ({ } flow, { } stage) => $" (сценарий «{flow}», этап «{stage}»)",
            ({ } flow, null) => $" (сценарий «{flow}»)",
            (null, { } stage) => $" (этап «{stage}»)",
            _ => "",
        };
        var what = rejection.Problem switch
        {
            "stage-duplicate-title" => "два этапа с одним названием",
            "flow-empty-name" => "сценарий без имени",
            "flow-duplicate-name" => "два сценария с одним именем",
            "flow-without-when" => "у сценария нет строки «когда»",
            "flow-without-stages" => "в сценарии нет этапов",
            "stage-unknown" => "пункт сценария ссылается на этап, которого нет",
            "stage-twice" => "этап стоит в сценарии дважды",
            "return-without-condition" => "возврат без условия",
            "return-unknown-stage" => "возврат ведёт к этапу, которого в сценарии нет",
            "return-stage-not-earlier" => "возврат ведёт к этапу, который стоит не раньше",
            "line-break" => "перевод строки там, где его быть не должно",
            var other => Problem(other),
        };
        return what + where;
    }
}
