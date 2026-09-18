using AgentsKitWeb.Api.Bases;

namespace AgentsKitWeb.Api.Performers;

/// <summary>Запрос синхронизации: база и имя исполнителя. Confirmed — оператор увидел предупреждение и согласился.</summary>
public sealed record SyncPerformerRequest(string Base, string Name, bool Confirmed = false);

/// <summary>
/// Копия, куда коммит придётся некстати. Reason: branch — копия на master, откуда публикуется панель;
/// dirty — в копии лежит незакоммиченная работа. Без слова оператора панель в такую копию не пишет.
/// </summary>
public sealed record PerformerRiskyCopy(string Copy, string Name, string? Branch, string Reason);

/// <summary>
/// Исход по одной копии. Done — файл записан и закоммичен, Commit — короткий sha этого коммита;
/// иначе Error — вывод git дословно: синхронизация пяти копий может пройти наполовину.
/// </summary>
public sealed record PerformerSyncOutcome(string Copy, string Name, bool Done, string? Commit, string? Error);

public sealed record PerformerSyncResponse(IReadOnlyList<PerformerSyncOutcome> Copies);

/// <summary>
/// Problem: no-main-copy — основной копии нет на диске; not-in-main — исполнителя нет в основной копии,
/// а брать его из чужой ветки панель не станет; needs-confirmation — Risky назовёт, чего ждёт панель.
/// </summary>
public sealed record PerformerSyncRefusedResponse(string Problem, IReadOnlyList<PerformerRiskyCopy> Risky);

/// <summary>
/// Синхронизация исполнителя по копиям проекта — отдельное действие оператора, а не побочный шаг
/// заведения: коммит в чужую ветку, где идёт чужая задача, остаётся его решением — B-77.
/// </summary>
public static class PerformerSyncEndpoints
{
    private const string SyncMessage = "Исполнитель синхронизирован из панели";

    public static void MapPerformerSyncEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/performers/sync", async (
            SyncPerformerRequest request,
            BasesStore bases,
            CancellationToken cancellationToken) =>
        {
            // Пишется только в копии базы из списка панели, и имя собирает путь: чужого файла им не назвать.
            if (bases.List().FirstOrDefault(b => BasesStore.SamePath(b, request.Base)) is not { } basePath)
                return Results.NotFound();
            var name = request.Name?.Trim();
            if (!PerformerFile.ValidName(name))
                return Results.BadRequest(new PerformerRejectedResponse("invalid-name"));

            var copies = await PerformersEndpoints.CopiesAsync(basePath, cancellationToken);
            if (copies.FirstOrDefault(c => c.Main) is not { } main)
                return Refused("no-main-copy");

            var source = System.IO.Path.Combine(PerformerList.AgentsDirectory(main.Path), PerformerFile.FileName(name!));
            if (!File.Exists(source))
                return Refused("not-in-main");

            string text;
            try
            {
                text = await File.ReadAllTextAsync(source, cancellationToken);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return Results.Problem("Файл исполнителя не прочитан", statusCode: StatusCodes.Status500InternalServerError);
            }

            var targets = new List<PerformerCopy>();
            foreach (var copy in copies.Where(c => !c.Main))
            {
                var file = System.IO.Path.Combine(PerformerList.AgentsDirectory(copy.Path), PerformerFile.FileName(name!));
                if (!File.Exists(file) || !PerformerList.SameText(await ReadOrEmptyAsync(file, cancellationToken), text))
                    targets.Add(copy);
            }
            if (targets.Count == 0)
                return Results.Ok(new PerformerSyncResponse([]));

            if (!request.Confirmed)
            {
                var risky = new List<PerformerRiskyCopy>();
                foreach (var copy in targets)
                    if (await RiskAsync(copy, name!, cancellationToken) is { } reason)
                        risky.Add(new PerformerRiskyCopy(copy.Path, copy.Name, copy.Branch, reason));
                if (risky.Count > 0)
                    return Results.Conflict(new PerformerSyncRefusedResponse("needs-confirmation", risky));
            }

            var outcomes = new List<PerformerSyncOutcome>();
            foreach (var copy in targets)
                outcomes.Add(await WriteAsync(copy, name!, text, cancellationToken));
            return Results.Ok(new PerformerSyncResponse(outcomes));
        });
    }

    /// <summary>Кладёт файл в копию и коммитит его тем же одним путём, что и заведение.</summary>
    private static async Task<PerformerSyncOutcome> WriteAsync(
        PerformerCopy copy, string name, string text, CancellationToken cancellationToken)
    {
        var directory = PerformerList.AgentsDirectory(copy.Path);
        var file = System.IO.Path.Combine(directory, PerformerFile.FileName(name));
        try
        {
            System.IO.Directory.CreateDirectory(directory);
            await File.WriteAllTextAsync(file, text, cancellationToken);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new PerformerSyncOutcome(copy.Path, copy.Name, false, null, "Файл исполнителя не записан");
        }

        var relative = PerformerFile.Directory + "/" + PerformerFile.FileName(name);
        var added = await PerformerGit.AddFileAsync(copy.Path, relative, cancellationToken);
        if (!added.Done)
            return new PerformerSyncOutcome(copy.Path, copy.Name, false, null, added.Error);

        var committed = await PerformerGit.CommitFileAsync(copy.Path, relative, SyncMessage, cancellationToken);
        if (!committed.Done)
        {
            // Иначе файл остался бы в индексе копии и уехал бы в коммит сессии, которая в ней работает.
            await PerformerGit.UnstageFileAsync(copy.Path, relative, cancellationToken);
            return new PerformerSyncOutcome(copy.Path, copy.Name, false, null, committed.Error);
        }

        return new PerformerSyncOutcome(copy.Path, copy.Name, true, await PerformerGit.HeadAsync(copy.Path, cancellationToken), null);
    }

    /// <summary>
    /// Чем копия рискованна, или null. Сам файл исполнителя в счёт не идёт: расхождение по нему —
    /// как раз то, что синхронизация и чинит.
    /// </summary>
    private static async Task<string?> RiskAsync(PerformerCopy copy, string name, CancellationToken cancellationToken)
    {
        if (string.Equals(copy.Branch, "master", StringComparison.OrdinalIgnoreCase))
            return "branch";
        return await PerformerGit.DirtyAsync(copy.Path, PerformerFile.Directory + "/" + PerformerFile.FileName(name), cancellationToken)
            ? "dirty"
            : null;
    }

    private static async Task<string> ReadOrEmptyAsync(string file, CancellationToken cancellationToken)
    {
        try
        {
            return await File.ReadAllTextAsync(file, cancellationToken);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private static IResult Refused(string problem) =>
        Results.Conflict(new PerformerSyncRefusedResponse(problem, []));
}
