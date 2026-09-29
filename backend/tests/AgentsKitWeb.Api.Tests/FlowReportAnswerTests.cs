using AgentsKitWeb.Api.Reports;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowReportAnswerTests
{
    private static readonly FlowRequirements Requirements = new(
        "## Требования к флоу",
        ["Проходимость", "Согласованность"],
        [
            new("П1", "Проходимость", Priority.High, "Каждый исход куда-то ведёт", "…"),
            new("С1", "Согласованность", Priority.High, "Флоу себе не противоречит", "…"),
        ]);

    [Fact]
    public void Parse_TakesFindingsAndDiscussionsFromFencedJson()
    {
        const string answer = """
            ```json
            {
              "findings": [
                {
                  "requirements": ["П1", "С1", "П1"],
                  "place": " Мерж ",
                  "quotes": [{ "where": "Мерж, описание", "text": "Спросить «принято»." }, { "where": "", "text": "пусто" }],
                  "why": "На отказ оператора задаче некуда идти.",
                  "fix": "Добавить возврат на этап «Реализация»."
                }
              ],
              "discussions": [
                { "title": "Делить ли мерж", "place": "Мерж", "now": "Один этап.", "for": "Проще проверить.", "against": "Больше отметок." },
                { "title": "" }
              ]
            }
            ```
            """;

        var parsed = FlowReportAnswer.Parse(answer, Requirements, out var error)!.Value;

        Assert.Equal("", error);
        var finding = Assert.Single(parsed.Findings);
        Assert.Equal(["П1", "С1"], finding.Requirements);
        Assert.Equal("Мерж", finding.Place);
        Assert.Equal([new ReportQuote("Мерж, описание", "Спросить «принято».")], finding.Quotes);
        Assert.Equal("1", finding.Id);
        Assert.Equal(new ReportDiscussion("Делить ли мерж", "Мерж", "Один этап.", "Проще проверить.", "Больше отметок."), Assert.Single(parsed.Discussions));
    }

    [Fact]
    public void Parse_NoFindings_IsCleanFlow()
    {
        var parsed = FlowReportAnswer.Parse("""{"findings":[],"discussions":[]}""", Requirements, out _)!.Value;

        Assert.Empty(parsed.Findings);
        Assert.Empty(parsed.Discussions);
    }

    [Theory]
    [InlineData("Флоу хороший.", "ответ не разобран")]
    [InlineData("""{"findings":[{"requirements":["Х9"],"place":"Мерж","why":"…","fix":"…"}]}""", "требование Х9, которого нет")]
    [InlineData("""{"findings":[{"requirements":[],"place":"Мерж","why":"…","fix":"…"}]}""", "не названо требование")]
    [InlineData("""{"findings":[{"requirements":["П1"],"place":"Мерж","why":"…"}]}""", "не сказано, что сделать")]
    public void Parse_Rejected_NamesReason(string answer, string reason)
    {
        Assert.Null(FlowReportAnswer.Parse(answer, Requirements, out var error));
        Assert.Contains(reason, error);
    }
}
