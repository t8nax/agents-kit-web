using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>YouTrack вместо настоящего: тесты не ходят в сеть. Asked — сервер и ключ каждого вопроса.</summary>
internal sealed class FakeYouTrack : IYouTrack
{
    public YouTrackUser Who { get; set; } = new("boris.k");

    public TrackerIssues Answer { get; set; } = new([]);

    public CreatedIssue Created { get; set; } = new(null, TrackerIssues.YouTrackError, "не задано тестом");

    public List<(string Server, string Key)> Asked { get; } = [];

    /// <summary>Сервер, ключ, проект, заголовок и описание каждой заведённой задачи.</summary>
    public List<(string Server, string Key, string Project, string Title, string Body)> Creates { get; } = [];

    public List<(string Server, string Key, string Project)> Read { get; } = [];

    public Task<YouTrackUser> WhoAsync(string server, string key, CancellationToken cancellationToken)
    {
        lock (Asked)
            Asked.Add((server, key));
        return Task.FromResult(Who);
    }

    /// <summary>Строка отбора каждого чтения задач: null — без отбора.</summary>
    public List<string?> Queries { get; } = [];

    public Task<TrackerIssues> AssignedAsync(
        string server, string key, string project, string? query, CancellationToken cancellationToken)
    {
        lock (Read)
        {
            Read.Add((server, key, project));
            Queries.Add(query);
        }
        return Task.FromResult(Answer);
    }

    public Task<CreatedIssue> CreateAsync(string server, string key, string project, string title, string body)
    {
        lock (Creates)
            Creates.Add((server, key, project, title, body));
        return Task.FromResult(Created);
    }
}
