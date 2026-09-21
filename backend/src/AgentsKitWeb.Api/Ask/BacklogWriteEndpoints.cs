using System.Diagnostics;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Flow;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Ask;

public sealed record BacklogWriteRequest(string? Base, string? Text);

/// <summary>
/// Событие записи в бэклог, одной строкой NDJSON. Type: step — ход работы агента (Text); written — записи
/// появились и закоммичены (Entries, Commit, DurationMs, Text — итог агента); error — записи нет или она не
/// закоммичена (Text — почему, Output — что вывел агент, Entries — появившиеся записи, если они есть).
/// </summary>
public sealed record BacklogWriteEvent(
    string Type,
    string Text,
    IReadOnlyList<BacklogEntry>? Entries = null,
    string? Commit = null,
    long? DurationMs = null,
    string? Output = null) : IAgentEvent;

public static class BacklogWriteEndpoints
{
    public const string BacklogFile = "backlog.md";

    /// <summary>Сообщение коммита у всех записей из панели одно: оно стоит в правиле разрешения.</summary>
    public const string CommitMessage = "Записать в бэклог из панели";

    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    public static void MapBacklogWriteEndpoints(this IEndpointRouteBuilder app)
    {
        // Просьбу держит панель: POST её заводит и отдаёт сводку, а ход окно читает потоком просьбы.
        app.MapPost("/api/backlog/write", (
            BacklogWriteRequest request, BasesStore bases, IAgentProcess agent, AgentRequests requests) =>
        {
            var basePath = request.Base is null ? null : bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base));
            if (basePath is null || !Directory.Exists(basePath))
                return Results.NotFound();
            if (string.IsNullOrWhiteSpace(request.Text))
                return Results.BadRequest();

            var text = request.Text.Trim();
            var started = requests.Start(
                AgentRequests.Backlog, basePath, ProjectName.Of(basePath), text,
                async (writing, cancellationToken) =>
                    writing.Write(await RunAsync(basePath, text, agent, writing, cancellationToken)));
            return Results.Ok(started.Summary);
        });
    }

    private static async Task<BacklogWriteEvent> RunAsync(
        string basePath, string text, IAgentProcess agent, AgentRequest writing, CancellationToken aborted)
    {
        // Навык кита работает только там, где кит подаёт базу, — в копии проекта, а не в каталоге базы.
        var copy = WorkspaceCollector.ReadCopies(basePath) is { } copies ? WorkspaceCollector.NewCopySource(copies) : null;
        if (copy is null)
            return new BacklogWriteEvent("error", "Нет основной копии проекта на диске: агенту негде запустить навык записи");

        var before = ReadNumbers(basePath);
        if (before is null)
            return new BacklogWriteEvent("error", "В базе нет backlog.md или он не прочитан");
        // Агент коммитит backlog.md целиком: чужая незакоммиченная правка ушла бы в его коммит.
        switch (await BaseGit.IsDirtyAsync(basePath, BacklogFile, aborted))
        {
            case null:
                return new BacklogWriteEvent("error", "git не прочитал базу — запись не начата");
            case true:
                return new BacklogWriteEvent("error", "В backlog.md базы есть незакоммиченная правка — запись не начата");
        }

        var stream = new ClaudeStream(basePath, copy);
        AskEvent? result = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        AgentExit exit;
        try
        {
            exit = await agent.RunAsync(
                StartInfo(basePath, copy),
                $"/agents-kit:backlog {text}",
                line =>
                {
                    foreach (var e in stream.Read(line))
                    {
                        if (e.Type == "step")
                            writing.Write(new BacklogWriteEvent("step", e.Text));
                        else
                            result = e;
                    }
                    return Task.CompletedTask;
                },
                timeout.Token);
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return await Outcome(basePath, before, new BacklogWriteEvent("error", $"{AgentRequests.AgentName} не закончил за пять минут и остановлен"));
        }

        if (result is null)
            return await Outcome(basePath, before, Failure(exit, stream));
        if (result.Type == "error")
            return await Outcome(basePath, before, new BacklogWriteEvent("error", result.Text, Output: result.Output));
        return await Outcome(basePath, before, null, result);
    }

    /// <summary>
    /// Итог по файлу, а не по словам агента: новые записи — номера, которых не было до запуска. Сбой агента
    /// после правки файла всё равно показывает, что появилось в бэклоге.
    /// </summary>
    private static async Task<BacklogWriteEvent> Outcome(
        string basePath, HashSet<string> before, BacklogWriteEvent? failure, AskEvent? answer = null)
    {
        var added = ReadEntries(basePath)?.Where(e => e.Number is { } n && !before.Contains(n)).ToList() ?? [];
        var output = answer?.Text is { Length: > 0 } said ? said : null;

        if (failure is not null)
            return added.Count == 0 ? failure : failure with { Entries = added };
        if (added.Count == 0)
            return new BacklogWriteEvent("error", $"{AgentRequests.AgentName} закончил, но новых записей в бэклоге нет", Output: output);
        if (await BaseGit.IsDirtyAsync(basePath, BacklogFile, CancellationToken.None) != false)
            return new BacklogWriteEvent("error", "Записи появились, но backlog.md не закоммичен", added, Output: output);

        var commit = await BaseGit.LastCommitAsync(basePath, BacklogFile, CancellationToken.None);
        return new BacklogWriteEvent("written", answer?.Text ?? "", added, commit, answer?.DurationMs);
    }

    /// <summary>
    /// Агент видит код копии и базу, но меняет только backlog.md базы и коммитит только его: остальные
    /// инструменты отключены, а режим dontAsk отказывает всему, что не разрешено правилом. Текст оператора
    /// уходит в stdin после имени навыка — не в аргументы.
    /// </summary>
    public static ProcessStartInfo StartInfo(string basePath, string copyPath)
    {
        var backlog = Path.Combine(basePath, BacklogFile);
        // Команда коммита — одна строка и для правила, и для промпта: правило PowerShell со звёздочкой
        // не совпадает с командой git ни в каком виде, совпадает только записанная целиком. Поэтому
        // сообщение коммита пишет панель, а не агент: его текст — часть разрешённой команды.
        var commit = $"git -C \"{basePath}\" commit -m \"{CommitMessage}\" -- {BacklogFile}";
        var systemPrompt = $"""
            Ты записываешь в бэклог базы знаний то, что оператор сказал в веб-панели; спросить оператора нельзя.
            Менять можно только файл {backlog}. Коммит — ровно одной командой PowerShell, слово в слово: {commit}
            Сообщение коммита не менять: разрешена ровно эта команда. Другие команды запрещены и не нужны.
            """;

        var startInfo = AgentProcess.StartInfo(AskEndpoints.Claude, copyPath);
        foreach (var arg in new[]
                 {
                     "-p",
                     "--output-format", "stream-json",
                     "--verbose",
                     "--tools", "Read,Grep,Glob,Edit,PowerShell,Skill",
                     "--add-dir", basePath,
                     "--permission-mode", "dontAsk",
                     "--allowedTools", "Read", "Grep", "Glob", "Skill",
                     $"Edit({backlog})",
                     $"PowerShell({commit})",
                     "--no-session-persistence",
                     "--strict-mcp-config",
                     "--append-system-prompt", systemPrompt,
                 })
            startInfo.ArgumentList.Add(arg);
        return startInfo;
    }

    private static BacklogWriteEvent Failure(AgentExit exit, ClaudeStream stream)
    {
        if (exit.ExitCode is null)
            return new BacklogWriteEvent("error", "Claude Code не запустился", Output: exit.Error);

        var output = string.Join("\n", new[] { exit.Error, stream.Unparsed }.Where(t => t.Length > 0));
        return new BacklogWriteEvent(
            "error",
            $"{AgentRequests.AgentName} завершился без итога",
            Output: output.Length > 0 ? output : $"код выхода {exit.ExitCode}");
    }

    // Номера разбор бэклога отдаёт в виде кита: «В-7», набранный руками, — тот же «B-7» (Workspaces/BacklogNumber).
    private static HashSet<string>? ReadNumbers(string basePath) =>
        ReadEntries(basePath)?.Select(e => e.Number).OfType<string>().ToHashSet();

    private static IReadOnlyList<BacklogEntry>? ReadEntries(string basePath)
    {
        try
        {
            return Backlog.Parse(File.ReadAllText(Path.Combine(basePath, BacklogFile)));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
