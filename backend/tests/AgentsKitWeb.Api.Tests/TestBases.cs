using System.Text.Json;

namespace AgentsKitWeb.Api.Tests;

internal static class TestBases
{
    /// <summary>Пишет bases.json со списком баз во временный каталог и возвращает его путь.</summary>
    public static string File(string root, params string[] bases)
    {
        var file = Path.Combine(root, "panel", "bases.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        System.IO.File.WriteAllText(file, JsonSerializer.Serialize(new { bases }));
        return file;
    }
}
