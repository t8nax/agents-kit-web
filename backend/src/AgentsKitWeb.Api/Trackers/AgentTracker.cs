using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>
/// Как агент панели ходит в трекер проекта — так, как его описывает tracker.md, а не ключом панели (AKW-15):
/// у GitHub — программой gh оператора, у YouTrack и Jira — подключением MCP самого Claude Code к серверу из строки
/// «сервер:», у облачной Jira — и к удалённому серверу Atlassian (B-285).
/// Ключ подключения лежит в настройках Claude Code оператора; панель подаёт агенту только это одно подключение
/// (--strict-mcp-config): прочих подключений Claude Code — Slack, почты — агент не видит.
/// Mcp задан — подключение найдено; у YouTrack и Jira без него агент в трекер не пройдёт и скажет это.
/// </summary>
public sealed record AgentTracker(TrackerInfo Tracker, string? McpName = null, string? McpConfig = null)
{
    /// <summary>Правило, которым агент запускает gh; другие команды оболочки ему не пускаются.</summary>
    public const string GhRule = "PowerShell(gh issue *)";

    public bool GitHub => Tracker.GitHubRepo is not null;

    /// <summary>Пройти в трекер агенту есть чем: gh у GitHub или найденное подключение у YouTrack и Jira.</summary>
    public bool Reachable => GitHub || McpName is not null;

    /// <summary>Правила --allowedTools: всё подключение MCP или команды gh.</summary>
    public IEnumerable<string> AllowedTools =>
        GitHub ? [GhRule] : McpName is { } name ? [$"mcp__{name}"] : [];

    /// <summary>
    /// Аргументы запуска: подключение трекера строкой --mcp-config, а не файлом — файл с ключом остался бы на диске.
    /// Все подключения закрыты (--strict-mcp-config) в любом случае.
    /// </summary>
    public void AddMcp(ProcessStartInfo startInfo)
    {
        if (McpConfig is null)
            return;
        startInfo.ArgumentList.Add("--mcp-config");
        startInfo.ArgumentList.Add(McpConfig);
    }

    /// <summary>Абзац системного промпта: где трекер и чем в него ходить, или почему в него не пройти.</summary>
    public string Prompt
    {
        get
        {
            var where = $"Трекер проекта — {Tracker.Name}, проект {Tracker.Project} на {Tracker.Server}.";
            if (GitHub)
                return $"""
                    {where} Задачи трекера читай и меняй программой gh командами PowerShell «gh issue …» с --repo {Tracker.GitHubRepo}:
                    gh issue list --state all --search, gh issue view --comments, gh issue create, gh issue edit, gh issue comment, gh issue close.
                    Другие команды оболочки тебе не разрешены. Не вошла gh или нет доступа к репозиторию — скажи оператору, что в трекер не пройти.
                    """;
            if (McpName is { } name)
                return $"""
                    {where} Задачи трекера читай и меняй инструментами подключения {name} (mcp__{name}__…), и только ими.
                    Не отвечает подключение или отказывает — скажи оператору, что в трекер не пройти.
                    """;
            return $"""
                {where} Подключения к этому трекеру в Claude Code на этом компьютере нет: в трекер тебе не пройти.
                Спросят о задачах трекера или попросят его изменить — скажи это оператору и посоветуй подключить {Tracker.Name} в Claude Code.
                """;
        }
    }

    /// <summary>Как с трекером работать: искать среди всех задач, менять — только по слову оператора.</summary>
    public const string Rules = """
        Ищи среди всех задач проекта — открытых и закрытых — и называй, закрыта ли задача и на кого назначена.
        Меняй трекер — состояние, комментарий, новая задача — только когда оператор об этом просит в разговоре.
        """;
}

/// <summary>
/// Находит доступ агента к трекеру проекта (AKW-15). Подключения MCP читаются из настроек Claude Code оператора —
/// .claude.json рядом с каталогом профиля .claude: свои у каталога, где идёт агент (projects), общие (mcpServers) —
/// и из .mcp.json этого каталога. Подходит подключение по адресу (http или sse), чей хост — хост сервера трекера.
/// Ключа входа Claude Code панель не касается: читаются только записи подключений (decisions/usage.md).
/// </summary>
public sealed class AgentTrackers(string claudeDir)
{
    private string ConfigFile => Path.Combine(Path.GetDirectoryName(Path.GetFullPath(claudeDir)) ?? claudeDir, ".claude.json");

    /// <summary>
    /// Удалённый сервер MCP Atlassian: облачная Jira подключается к Claude Code им, а не адресом своего сайта (B-285).
    /// </summary>
    public const string AtlassianHost = "mcp.atlassian.com";

    /// <summary>Трекер базы для агента, идущего в каталогах dirs (первый — рабочий); трекера нет или не GitHub/YouTrack/Jira — null.</summary>
    public AgentTracker? For(BaseLayout? layout, params string?[] dirs)
    {
        if (layout is null || ProjectTracker.Movable(layout) is not { } tracker)
            return null;
        if (tracker.Kind is not (TrackerInfo.YouTrack or TrackerInfo.Jira) || tracker.Server is null)
            return new AgentTracker(tracker);

        // Подходит подключение к хосту сервера трекера, а у облачной Jira (сайт на atlassian.net) — и к удалённому серверу
        // Atlassian: серверной Jira облачное подключение не годится — задача ушла бы не в тот трекер (ревью B-285)
        var site = new Uri(tracker.Server).Host;
        string[] hosts = tracker.Kind == TrackerInfo.Jira && site.EndsWith(".atlassian.net", StringComparison.OrdinalIgnoreCase)
            ? [site, AtlassianHost]
            : [site];
        foreach (var (name, entry) in Servers(dirs.OfType<string>().ToList()))
            if (entry["url"]?.GetValueKind() == JsonValueKind.String
                && Uri.TryCreate(entry["url"]!.GetValue<string>(), UriKind.Absolute, out var url)
                && hosts.Any(host => url.Host.Equals(host, StringComparison.OrdinalIgnoreCase)))
            {
                var config = new JsonObject { ["mcpServers"] = new JsonObject { [name] = entry.DeepClone() } };
                return new AgentTracker(tracker, name, config.ToJsonString());
            }
        return new AgentTracker(tracker);
    }

    /// <summary>Подключения по порядку: свои у каталога агента, из его .mcp.json, общие.</summary>
    private IEnumerable<(string Name, JsonObject Entry)> Servers(IReadOnlyList<string> dirs)
    {
        var config = ReadObject(ConfigFile);
        if (config?["projects"] is JsonObject projects)
            foreach (var dir in dirs)
                foreach (var (key, project) in projects)
                    if (BasesStore.SamePath(key, dir) && project?["mcpServers"] is JsonObject own)
                        foreach (var server in Entries(own))
                            yield return server;
        foreach (var dir in dirs)
            if (ReadObject(Path.Combine(dir, ".mcp.json"))?["mcpServers"] is JsonObject shared)
                foreach (var server in Entries(shared))
                    yield return server;
        if (config?["mcpServers"] is JsonObject user)
            foreach (var server in Entries(user))
                yield return server;
    }

    private static IEnumerable<(string, JsonObject)> Entries(JsonObject servers) =>
        servers.Where(s => s.Value is JsonObject).Select(s => (s.Key, (JsonObject)s.Value!));

    /// <summary>Файл чужого формата: нет его, не прочитан или не разобран — подключений нет.</summary>
    private static JsonObject? ReadObject(string file)
    {
        try
        {
            return File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
