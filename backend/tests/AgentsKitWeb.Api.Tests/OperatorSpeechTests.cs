using System.Diagnostics;
using AgentsKitWeb.Api.Ask;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Performers;
using AgentsKitWeb.Api.Reports;
using AgentsKitWeb.Api.Trackers;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Правило о языке ответа оператору — одно на все разговоры Чудо-Юдо и разбор флоу для отчёта (B-324). Вопрос
/// по базе держит своё в AskEndpointsTests: его подсказка собирается внутри запроса.
/// </summary>
public sealed class OperatorSpeechTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("akw-speech-").FullName;

    public void Dispose() => TestDirs.Delete(_root);

    private static string Prompt(ProcessStartInfo startInfo)
    {
        var args = startInfo.ArgumentList.ToList();
        return args[args.IndexOf("--append-system-prompt") + 1];
    }

    public static TheoryData<string> Conversations => ["backlog", "flow", "tracker", "performer", "performer-edit", "report"];

    private ProcessStartInfo StartInfo(string conversation) => conversation switch
    {
        "backlog" => BacklogWriteEndpoints.StartInfo(_root, _root),
        "flow" => FlowRewriteEndpoints.StartInfo(_root, _root, "Orders", "правила"),
        "tracker" => TrackerRewriteEndpoints.StartInfo(_root, _root, "Orders", "правила"),
        "performer" => PerformerDraftEndpoints.StartInfo(_root, _root, "Orders", editing: false),
        "performer-edit" => PerformerDraftEndpoints.StartInfo(_root, _root, "Orders", editing: true),
        "report" => FlowReports.StartInfo(_root, _root, "Orders"),
        _ => throw new ArgumentOutOfRangeException(nameof(conversation)),
    };

    [Theory]
    [MemberData(nameof(Conversations))]
    public void StartInfo_GivesAgentOperatorSpeechRule(string conversation) =>
        Assert.Contains(OperatorSpeech.Rule, Prompt(StartInfo(conversation)));

    [Fact]
    public void Rule_KeepsDetailsForOperatorsDirectRequest() =>
        Assert.Contains("Файл или имя называй, только если оператор сам об этом просит", OperatorSpeech.Rule);

    [Fact]
    public void Backlog_SendsDetailsToAgentPartOfRecord() =>
        Assert.Contains("пиши в раздел\n«### Агенту» записи, а не в ответ оператору",
            Prompt(StartInfo("backlog")).ReplaceLineEndings("\n"));

    [Fact]
    public void Report_KeepsQuotesVerbatim() =>
        Assert.Contains("кроме цитат quotes: они дословные", Prompt(StartInfo("report")));
}
