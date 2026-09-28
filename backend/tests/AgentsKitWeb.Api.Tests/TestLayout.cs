using System.Text.Json;
using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// База кита нынешнего формата для тестов (BaseLayout): agents-kit.json, local\me.json с копиями и оператором этой
/// машины и личный репозиторий local\me со своим git, пока без коммитов. Git самой базы тест заводит сам, когда он ему нужен.
/// </summary>
internal static class TestLayout
{
    public const string Operator = "tester";

    /// <summary>Заводит базу и возвращает её путь.</summary>
    public static string Base(string path, params string[] copies)
    {
        Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(path, BaseLayout.MarkerFile),
            JsonSerializer.Serialize(new { kit = "agents-kit", prefix = "B", version = BaseLayout.Format }));
        File.WriteAllText(Path.Combine(path, ".gitignore"), "local/\n");
        Machine(path, Operator, copies);
        // Без коммита: объекты git лежат «только для чтения», и уборка классов, не ждущих git, на них падала бы.
        Directory.CreateDirectory(Personal(path));
        TestGit.Run(Personal(path), "init", "-q", "-b", "dev");
        Directory.CreateDirectory(Work(path));
        return path;
    }

    /// <summary>Переводит базу на формат новее панели, как это делает кит, — раскладка остаётся прежней.</summary>
    public static void NewerFormat(string basePath) =>
        File.WriteAllText(Path.Combine(basePath, BaseLayout.MarkerFile),
            JsonSerializer.Serialize(new { kit = "agents-kit", prefix = "B", version = BaseLayout.Format + 1 }));

    /// <summary>Переписывает local\me.json базы: оператор этой машины и её копии.</summary>
    public static void Machine(string basePath, string? name, params string[] copies)
    {
        Directory.CreateDirectory(Path.Combine(basePath, "local"));
        File.WriteAllText(Path.Combine(basePath, "local", "me.json"),
            JsonSerializer.Serialize(new { @operator = name, workspaces = copies }));
    }

    public static string Personal(string basePath) => Path.Combine(basePath, "local", "me");

    /// <summary>Каталог памяти задач этой машины в личном репозитории.</summary>
    public static string Work(string basePath) => Path.Combine(Personal(basePath), "work", BaseLayout.Machine());

    /// <summary>Папка оператора в общей базе — выложенное для коллег; панель её не читает.</summary>
    public static string Published(string basePath) => Path.Combine(basePath, "people", Operator);

    public static string Flow(string basePath) => Path.Combine(Personal(basePath), "flow");

    public static string Agents(string basePath) => Path.Combine(Personal(basePath), "agents");

    public static string Backlog(string basePath) => Path.Combine(Personal(basePath), "backlog.md");
}
