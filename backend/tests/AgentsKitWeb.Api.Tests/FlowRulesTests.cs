using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowRulesTests : IDisposable
{
    private readonly string _kit = Directory.CreateTempSubdirectory("akw-rules-").FullName;

    [Fact]
    public void Read_TakesStageAndOutsideSectionsOfKitReference()
    {
        Write("""
            # Флоу: сценарии и этапы

            Вступление.

            ## Сценарий

            Сценарии — flow/scenarios.md.

            ## Этап

            Ключи — закрытый перечень.

            ### Пример

            # Ревью

            ## Чего во флоу нет

            Инвариантов кита во флоу нет.

            ## Находки сверки

            Красные — такой флоу не коммитится.
            """);

        var rules = FlowRules.Read(_kit)!;

        Assert.StartsWith("## Этап", rules);
        Assert.Contains("### Пример", rules);
        Assert.Contains("## Чего во флоу нет\n\nИнвариантов кита во флоу нет.", rules);
        Assert.DoesNotContain("Сценарии — flow/scenarios.md.", rules);
        Assert.DoesNotContain("Красные", rules);
        Assert.DoesNotContain("Вступление.", rules);
    }

    [Fact]
    public void Read_KitOfPriorForm_TakesStageSection()
    {
        // Кит прежнего вида звал раздел формы «Стадия».
        Write("# Флоу и стадии\n\n## Стадия\n\nКлючи — закрытый перечень.\n\n## Чего во флоу нет\n\nИнвариантов нет.\n");

        var rules = FlowRules.Read(_kit)!;

        Assert.StartsWith("## Стадия\n\nКлючи — закрытый перечень.", rules);
        Assert.Contains("## Чего во флоу нет", rules);
    }

    [Fact]
    public void Read_WithoutStageSection_ReturnsNull()
    {
        Write("# Флоу и стадии\n\n## Чего во флоу нет\n\nИнвариантов нет.\n");

        Assert.Null(FlowRules.Read(_kit));
    }

    [Fact]
    public void Read_WithoutKitOrFile_ReturnsNull()
    {
        Assert.Null(FlowRules.Read(null));
        Assert.Null(FlowRules.Read("  "));
        Assert.Null(FlowRules.Read(_kit));
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
