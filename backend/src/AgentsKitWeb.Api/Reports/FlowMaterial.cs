using System.Security.Cryptography;
using System.Text;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Performers;

namespace AgentsKitWeb.Api.Reports;

/// <summary>
/// Что разбирает отчёт: флоу оператора — flow/scenarios.md и файлы этапов — и описания его субагентов, как они лежат
/// в личном репозитории. Отпечаток по ним говорит расписанию, менялся ли флоу с последнего отчёта.
/// </summary>
public sealed record FlowMaterial(string Personal, string Flow, string Agents, string Fingerprint)
{
    /// <summary>У проекта есть сценарии — есть что разбирать.</summary>
    public static bool HasFlow(string basePath) =>
        File.Exists(Path.Combine(BaseLayout.Read(basePath)?.Personal ?? BaseLayout.PersonalOf(basePath), FlowFolder.ListFile));

    /// <summary>Флоу и субагенты базы; null — у проекта нет сценариев, разбирать нечего.</summary>
    public static async Task<FlowMaterial?> ReadAsync(string basePath, CancellationToken cancellationToken)
    {
        var personal = BaseLayout.Read(basePath)?.Personal ?? BaseLayout.PersonalOf(basePath);
        var list = Path.Combine(personal, FlowFolder.ListFile);
        if (!File.Exists(list))
            return null;

        var flow = new StringBuilder();
        await AppendAsync(flow, personal, list, cancellationToken);
        foreach (var file in Files(Path.Combine(personal, FlowFolder.StagesFolder)))
            await AppendAsync(flow, personal, file, cancellationToken);

        var agents = new StringBuilder();
        foreach (var file in Files(Path.Combine(personal, PerformerList.Folder)))
            await AppendAsync(agents, personal, file, cancellationToken);

        var both = flow + "\n\u0000\n" + agents;
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(both)));
        return new FlowMaterial(personal, flow.ToString().TrimEnd(), agents.ToString().TrimEnd(), fingerprint);
    }

    private static IEnumerable<string> Files(string folder) =>
        Directory.Exists(folder) ? Directory.EnumerateFiles(folder, "*.md").Order(StringComparer.Ordinal) : [];

    private static async Task AppendAsync(StringBuilder text, string personal, string file, CancellationToken cancellationToken)
    {
        // Переводы строк приводятся к одному виду: отпечаток не должен меняться от того, как git выкачал файл.
        var content = (await File.ReadAllTextAsync(file, cancellationToken)).ReplaceLineEndings("\n").TrimEnd();
        text.Append("=== ").Append(Path.GetRelativePath(personal, file).Replace('\\', '/')).Append('\n')
            .Append(content).Append("\n\n");
    }
}
