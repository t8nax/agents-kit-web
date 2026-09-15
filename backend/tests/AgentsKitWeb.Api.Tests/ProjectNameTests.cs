using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public sealed class ProjectNameTests : IDisposable
{
    private readonly string _base = Path.Combine(Directory.CreateTempSubdirectory("akw-project-").FullName, "app-knowledge");

    public ProjectNameTests() => Directory.CreateDirectory(_base);

    [Theory]
    [InlineData("# Order Service — продукт\n\n## Что за система\n", "Order Service")]
    [InlineData("# Order Service\r\n\r\nтекст\r\n", "Order Service")]
    [InlineData("<!-- # Каркас — продукт -->\n# Agents Kit Web — продукт\n", "Agents Kit Web")]
    [InlineData("вступление\n\n# Поздний заголовок — продукт\n", "Поздний заголовок")]
    [InlineData("## Только раздел\n", "app-knowledge")]
    [InlineData("", "app-knowledge")]
    public void Of_ReadsProductHeading(string product, string expected)
    {
        File.WriteAllText(Path.Combine(_base, "product.md"), product);

        Assert.Equal(expected, ProjectName.Of(_base));
    }

    [Fact]
    public void Of_NoProductFile_ReturnsFolderName()
    {
        Assert.Equal("app-knowledge", ProjectName.Of(_base + "\\"));
    }

    [Fact]
    public void Of_NoBase_ReturnsFolderName()
    {
        Assert.Equal("gone-knowledge", ProjectName.Of(Path.Combine(_base, "gone-knowledge")));
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path.GetDirectoryName(_base)!, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
