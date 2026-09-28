using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>GitHub тестов вместо программы gh: отвечает заданным и запоминает, о чём его спросили.</summary>
public sealed class FakeGitHubIssues : IGitHubIssues
{
    public TrackerIssues Answer { get; set; } = new([]);

    public List<string> Asked { get; } = [];

    /// <summary>Ответ на заведение задачи; не задан — задача заводится под следующим номером.</summary>
    public CreatedIssue? Created { get; set; }

    public List<(string Repo, string Title, string Body)> Creates { get; } = [];

    public Task<TrackerIssues> AssignedAsync(string repo, CancellationToken cancellationToken)
    {
        Asked.Add(repo);
        return Task.FromResult(Answer);
    }

    /// <summary>Ход перед ответом на заведение: им тест держит gh «в GitHub», пока проверяет, что делает второй перенос.</summary>
    public Func<Task> BeforeCreate { get; set; } = () => Task.CompletedTask;

    public async Task<CreatedIssue> CreateAsync(string repo, string title, string body)
    {
        int number;
        lock (Creates)
        {
            Creates.Add((repo, title, body));
            number = 57 + Creates.Count;
        }
        await BeforeCreate();
        return Created
            ?? new CreatedIssue(new TrackerIssue($"GitHub #{number}", number, title, $"https://github.com/{repo}/issues/{number}"));
    }
}
