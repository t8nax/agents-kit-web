using AgentsKitWeb.Api.Trackers;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>YouTrack вместо настоящего: тесты не ходят в сеть. Asked — сервер и ключ каждого вопроса.</summary>
internal sealed class FakeYouTrack : IYouTrack
{
    public YouTrackUser Who { get; set; } = new("boris.k");

    public TrackerIssues Answer { get; set; } = new([]);

    public List<(string Server, string Key)> Asked { get; } = [];

    public List<(string Server, string Key, string Project)> Read { get; } = [];

    public Task<YouTrackUser> WhoAsync(string server, string key, CancellationToken cancellationToken)
    {
        lock (Asked)
            Asked.Add((server, key));
        return Task.FromResult(Who);
    }

    /// <summary>Строка отбора каждого чтения задач: null — без отбора.</summary>
    public List<string?> Filters { get; } = [];

    public Task<TrackerIssues> OpenAsync(
        string server, string key, string project, string? filter, CancellationToken cancellationToken)
    {
        lock (Read)
        {
            Read.Add((server, key, project));
            Filters.Add(filter);
        }
        return Task.FromResult(Answer);
    }
}
