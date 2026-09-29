using System.Text.Json;
using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Reports;

/// <summary>
/// Ответ Чудо-Юдо о флоу — один блок JSON с находками и вопросами устройства. Разбирает его панель: номер рекомендации
/// сверяется со справкой кита, а баллы агент не считает вовсе — их считает панель по приоритетам рекомендаций.
/// </summary>
public static class FlowReportAnswer
{
    public static (IReadOnlyList<ReportFinding> Findings, IReadOnlyList<ReportDiscussion> Discussions)? Parse(
        string answer, FlowRequirements requirements, out string error)
    {
        error = "";
        Answer? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<Answer>(FlowRewriteEndpoints.Unfence(answer).Trim(), JsonOptions);
        }
        catch (JsonException)
        {
            parsed = null;
        }
        if (parsed is null)
        {
            error = "ответ не разобран: панель ждёт один блок JSON с находками";
            return null;
        }

        var findings = new List<ReportFinding>();
        foreach (var finding in parsed.Findings ?? [])
        {
            var codes = (finding.Requirements ?? []).Select(code => code.Trim()).Where(code => code.Length > 0).Distinct().ToList();
            if (codes.Count == 0)
            {
                error = "у находки не названа рекомендация";
                return null;
            }
            if (codes.FirstOrDefault(code => requirements.Find(code) is null) is { } unknown)
            {
                error = $"находка ссылается на рекомендацию {unknown}, которой нет в справке кита";
                return null;
            }
            if (Blank(finding.Place) || Blank(finding.Why) || Blank(finding.Fix))
            {
                error = "у находки не названо место, не сказано, почему это плохо, или не сказано, что сделать";
                return null;
            }

            var quotes = (finding.Quotes ?? [])
                .Where(quote => !Blank(quote.Where) && !Blank(quote.Text))
                .Select(quote => new ReportQuote(quote.Where!.Trim(), quote.Text!.Trim()))
                .ToList();
            findings.Add(new ReportFinding(
                (findings.Count + 1).ToString(), codes, finding.Place!.Trim(), quotes, finding.Why!.Trim(), finding.Fix!.Trim()));
        }

        var discussions = (parsed.Discussions ?? [])
            .Where(d => !Blank(d.Title))
            .Select(d => new ReportDiscussion(
                d.Title!.Trim(), d.Place?.Trim() ?? "", d.Now?.Trim() ?? "", d.For?.Trim() ?? "", d.Against?.Trim() ?? ""))
            .ToList();
        return (findings, discussions);
    }

    private static bool Blank(string? text) => string.IsNullOrWhiteSpace(text);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        AllowTrailingCommas = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    private sealed record Answer(IReadOnlyList<Finding>? Findings, IReadOnlyList<Discussion>? Discussions);

    private sealed record Finding(
        IReadOnlyList<string>? Requirements, string? Place, IReadOnlyList<Quote>? Quotes, string? Why, string? Fix);

    private sealed record Quote(string? Where, string? Text);

    private sealed record Discussion(string? Title, string? Place, string? Now, string? For, string? Against);
}
