using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Jira вместо настоящей: тесты не ходят в сеть. Asked — сервер, почта и ключ каждого вопроса о владельце.</summary>
internal sealed class FakeJira : IJira
{
    public JiraUser Who { get; set; } = new("acc-anna", "anna@acme.example");

    public TrackerIssues Answer { get; set; } = new([]);

    public List<(string Server, string Email, string Key)> Asked { get; } = [];

    public List<(string Server, string Email, string Key, string Project)> Read { get; } = [];

    /// <summary>Строка отбора каждого чтения задач: null — без отбора.</summary>
    public List<string?> Filters { get; } = [];

    public Task<JiraUser> WhoAsync(string server, string email, string key, CancellationToken cancellationToken)
    {
        lock (Asked)
            Asked.Add((server, email, key));
        return Task.FromResult(Who);
    }

    public Task<TrackerIssues> OpenAsync(
        string server, string email, string key, string project, string? filter, CancellationToken cancellationToken)
    {
        lock (Read)
        {
            Read.Add((server, email, key, project));
            Filters.Add(filter);
        }
        return Task.FromResult(Answer);
    }
}
