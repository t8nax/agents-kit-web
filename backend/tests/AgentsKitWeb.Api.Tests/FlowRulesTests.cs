using AgentsKitWeb.Api.Flow;

namespace AgentsKitWeb.Api.Tests;

public sealed class FlowRulesTests : IDisposable
{
    private readonly string _kit = Directory.CreateTempSubdirectory("akw-rules-").FullName;

    [Fact]
    public void Read_TakesStageAndOutsideSectionsOfKitReference()
    {
        Write("""
            # Флоу и стадии

            Вступление.

            ## Флоу

            Флоу — раздел flow/flow.md.

            ## Стадия

            Ключи — закрытый перечень.

            ### Пример

            # Ревью

            ## Чего во флоу нет

            Инвариантов кита во флоу нет.

            ## Находки сверки

            Красные — такой флоу не коммитится.
            """);

        var rules = FlowRules.Read(_kit)!;

        Assert.StartsWith("## Стадия", rules);
        Assert.Contains("### Пример", rules);
        Assert.Contains("## Чего во флоу нет\n\nИнвариантов кита во флоу нет.", rules);
        Assert.DoesNotContain("Флоу — раздел flow/flow.md.", rules);
        Assert.DoesNotContain("Красные", rules);
        Assert.DoesNotContain("Вступление.", rules);
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
