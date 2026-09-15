using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Название проекта базы — заголовок product.md без хвоста « — продукт», по правилу кита
/// (Get-KitProjectName в scripts/base-check.ps1). Заголовка нет — имя папки базы.
/// </summary>
public static partial class ProjectName
{
    public static string Of(string basePath)
    {
        string text;
        try
        {
            text = File.ReadAllText(Path.Combine(basePath, "product.md"));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return FolderName(basePath);
        }

        var match = Heading().Match(Comment().Replace(text, ""));
        return match.Success ? match.Groups[1].Value : FolderName(basePath);
    }

    private static string FolderName(string basePath) =>
        new DirectoryInfo(basePath.TrimEnd('\\', '/')).Name;

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment();

    [GeneratedRegex(@"^#\s+(.+?)(?:\s+—\s+продукт)?\s*$", RegexOptions.Multiline)]
    private static partial Regex Heading();
}
