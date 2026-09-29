namespace AgentsKitWeb.Api.Reports;

/// <summary>Кольцо отчёта: баллы, цвет — pass, avg или fail, — сколько в нём рекомендаций и сколько выполнено.</summary>
public sealed record RingScore(string Name, int Score, string Band, int Total, int Passed);

/// <summary>
/// Баллы колец. Кольцо — группа рекомендаций кита; оно начинается со 100, и каждая находка снимает по приоритету своей
/// рекомендации: высокий −15, средний −7, низкий −2. Находка под двумя рекомендациями снимает в обоих. Цвет: 90–100 —
/// зелёный, 50–89 — жёлтый, ниже — красный, и с находкой высокого приоритета кольцо не зелёное — решения оператора на B-270.
/// </summary>
public static class FlowReportScores
{
    public const string Pass = "pass";
    public const string Average = "avg";
    public const string Fail = "fail";

    public static int Weight(Priority priority) => priority switch
    {
        Priority.High => 15,
        Priority.Medium => 7,
        _ => 2,
    };

    public static IReadOnlyList<RingScore> Of(IReadOnlyList<Requirement> requirements, IReadOnlyList<ReportFinding> findings)
    {
        var byCode = requirements.ToDictionary(requirement => requirement.Code);
        // Невыполненное — пара «находка — рекомендация»: по ней и снимаются баллы.
        var violations = findings
            .SelectMany(finding => finding.Requirements)
            .Where(byCode.ContainsKey)
            .Select(code => byCode[code])
            .ToList();

        return requirements
            .Select(requirement => requirement.Ring)
            .Distinct()
            .Select(ring =>
            {
                var inRing = violations.Where(requirement => requirement.Ring == ring).ToList();
                var score = Math.Max(0, 100 - inRing.Sum(requirement => Weight(requirement.Priority)));
                var band = score < 50
                    ? Fail
                    : score >= 90 && inRing.All(requirement => requirement.Priority != Priority.High) ? Pass : Average;
                var total = requirements.Count(requirement => requirement.Ring == ring);
                var failed = inRing.Select(requirement => requirement.Code).Distinct().Count();
                return new RingScore(ring, score, band, total, total - failed);
            })
            .ToList();
    }
}
