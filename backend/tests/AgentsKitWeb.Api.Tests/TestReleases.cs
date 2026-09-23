using AgentsKitWeb.Api.Panel;

namespace AgentsKitWeb.Api.Tests;

/// <summary>Выпуски GitHub без GitHub: канал без выпусков — GitHub не ответил.</summary>
internal sealed class TestReleases : IPanelReleases
{
    private readonly Dictionary<string, IReadOnlyList<PanelRelease>> _channels = [];

    /// <summary>Последний вопрос: какой репозиторий и какой канал панель спросила.</summary>
    public (string Repository, string Channel)? Asked { get; private set; }

    public void Channel(string channel, params PanelRelease[] releases) => _channels[channel] = releases;

    public Task<IReadOnlyList<PanelRelease>?> ReadAsync(string repository, string channel, CancellationToken cancellationToken)
    {
        Asked = (repository, channel);
        return Task.FromResult(_channels.TryGetValue(channel, out var releases) ? releases : null);
    }
}
