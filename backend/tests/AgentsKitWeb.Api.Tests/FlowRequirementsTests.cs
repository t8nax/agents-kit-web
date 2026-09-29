using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Reports;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowRequirementsTests : IDisposable
{
    private readonly string _kit = Directory.CreateTempSubdirectory("akw-requirements-").FullName;

    public const string Section = """
        ## Рекомендации к флоу

        Рекомендации к смыслу флоу, которых сверка не проверяет. Выполнять ли каждую, решает оператор. Приоритет — что будет, если рекомендация не выполнена:

        - **высокий** — в тексте дыра или противоречие;
        - **средний** — две сессии поймут текст по-разному;
        - **низкий** — оформление.

        ### Проходимость
        - **П1** · высокий · **Каждый исход куда-то ведёт** — у каждого исхода есть продолжение.
        - **П5** · средний · **Нужное дальше — выходом** — нужное следующим этапам этап отдаёт выходом.

        ### Ясность
        - **Я4** · низкий · **Во флоу только порядок работы** — во флоу нет устройства системы.
        """;

    [Fact]
    public void Read_TakesRecommendationsByGroups()
    {
        Write($"# Флоу\n\n## Этап\n\nКлючи.\n\n{Section}\n## Дальше\n\nДругое.\n");

        var requirements = FlowRequirements.Read(_kit, out var error)!;

        Assert.Equal("", error);
        Assert.Equal(["Проходимость", "Ясность"], requirements.Rings);
        Assert.Equal(
            [
                new Requirement("П1", "Проходимость", Priority.High, "Каждый исход куда-то ведёт", "у каждого исхода есть продолжение."),
                new Requirement("П5", "Проходимость", Priority.Medium, "Нужное дальше — выходом", "нужное следующим этапам этап отдаёт выходом."),
                new Requirement("Я4", "Ясность", Priority.Low, "Во флоу только порядок работы", "во флоу нет устройства системы."),
            ],
            requirements.Items);
        Assert.StartsWith("## Рекомендации к флоу", requirements.Section);
        Assert.DoesNotContain("## Дальше", requirements.Section);
    }

    [Fact]
    public void Read_OldKitRequirements_TakenAlike()
    {
        // Кит прежнего вида звал раздел «Требования к флоу»: пока он у кого-то стоит, отчёт строится и по нему — B-298.
        Write($"# Флоу\n\n{Section.Replace("## Рекомендации к флоу", "## Требования к флоу")}");

        var requirements = FlowRequirements.Read(_kit, out var error)!;

        Assert.Equal("", error);
        Assert.Equal(["П1", "П5", "Я4"], requirements.Items.Select(item => item.Code));
        Assert.StartsWith("## Требования к флоу", requirements.Section);
    }

    [Fact]
    public void Read_TitleWithDash_KeepsItWhole()
    {
        // Кит не держит тире внутри названия, но формулировка отделяется первым « — » после названия в звёздочках.
        Write($"# Флоу\n\n{Section}");

        Assert.Equal("Нужное дальше — выходом", FlowRequirements.Read(_kit, out _)!.Find("П5")!.Title);
    }

    [Fact]
    public void Read_WithoutSection_NamesReason()
    {
        Write("# Флоу\n\n## Этап\n\nКлючи.\n");

        Assert.Null(FlowRequirements.Read(_kit, out var error));
        Assert.Contains("нет раздела «Рекомендации к флоу»", error);
        // Путь в словах оператору — через «/», как его пишет кит.
        Assert.Contains("reference/flow-stages.md", error);
    }

    [Fact]
    public void Read_UnreadableItem_NamesLine()
    {
        Write("# Флоу\n\n## Рекомендации к флоу\n\n### Проходимость\n- **П1** высокий Каждый исход\n");

        Assert.Null(FlowRequirements.Read(_kit, out var error));
        Assert.Contains("«- **П1** высокий Каждый исход»", error);
    }

    [Fact]
    public void Read_SectionWithoutItems_NamesReason()
    {
        Write("# Флоу\n\n## Рекомендации к флоу\n\nПока пусто.\n");

        Assert.Null(FlowRequirements.Read(_kit, out var error));
        Assert.Contains("нет ни одной рекомендации", error);
    }

    [Fact]
    public void Read_WithoutKitOrFile_NamesReason()
    {
        Assert.Null(FlowRequirements.Read(null, out var noKit));
        Assert.Contains("Путь к киту не задан", noKit);

        Assert.Null(FlowRequirements.Read(_kit, out var noFile));
        Assert.Contains("не прочитала справку кита", noFile);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_kit, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private void Write(string text)
    {
        var file = FlowRules.File(_kit);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text.ReplaceLineEndings("\n"));
    }
}
