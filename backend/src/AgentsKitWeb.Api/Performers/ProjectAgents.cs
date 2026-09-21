using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Имена, занятые в самом проекте. Кит развозит исполнителей базы по рабочим копиям, но файл,
/// который лежит в репозитории проекта под git, он не трогает: команда проекта ведёт его сама.
/// Значит исполнитель с таким именем в копию не приедет, и заводить его панель не даёт.
/// </summary>
internal static class ProjectAgents
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Копия проекта, где имя занято отслеживаемым git файлом, или null. Копии берутся из маркера
    /// базы; git не ответил — считаем, что имя свободно: запись важнее догадки о чужом репозитории.
    /// </summary>
    public static async Task<string?> TakenCopyAsync(string basePath, string name, CancellationToken cancellationToken)
    {
        if (WorkspaceCollector.ReadCopies(basePath) is not { } copies)
            return null;

        var file = ".claude/agents/" + PerformerFile.FileName(name);
        foreach (var copy in copies.Where(Directory.Exists))
        {
            var run = await GitRunner.RunAsync(copy, Timeout, cancellationToken, "ls-files", "--", file);
            if (run.ExitCode == 0 && run.Output.Length > 0)
                return copy;
        }
        return null;
    }
}
