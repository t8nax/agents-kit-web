namespace AgentsKitWeb.Api.Bases;

/// <summary>Папка в обзоре. IsBase — в ней есть agents-kit.json; Copies — число копий из него, null — не прочитан.</summary>
public sealed record FolderEntry(string Name, string Path, bool IsBase, int? Copies);

/// <summary>Содержимое папки. Path null — список дисков; Parent null — выше только список дисков.</summary>
public sealed record FolderListing(string? Path, string? Parent, IReadOnlyList<FolderEntry> Folders);

public sealed record FolderRejectedResponse(string Problem);

/// <summary>
/// Обзор папок для выбора базы: браузер полного пути к папке странице не отдаёт,
/// а системный диалог потребовал бы запускать внешний процесс.
/// </summary>
public static class FoldersEndpoints
{
    public static void MapFoldersEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/folders", (string? path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
                return Results.Ok(new FolderListing(null, null, Drives()));

            var trimmed = path.Trim();
            if (!System.IO.Path.IsPathFullyQualified(trimmed))
                return Results.BadRequest(new FolderRejectedResponse("not-full-path"));

            var full = System.IO.Path.GetFullPath(trimmed);
            if (!Directory.Exists(full))
                return Results.NotFound(new FolderRejectedResponse("not-found"));

            try
            {
                return Results.Ok(new FolderListing(full, Directory.GetParent(full)?.FullName, Subfolders(full)));
            }
            catch (UnauthorizedAccessException)
            {
                return Results.Json(new FolderRejectedResponse("access-denied"), statusCode: StatusCodes.Status403Forbidden);
            }
        });
    }

    private static List<FolderEntry> Drives() =>
        DriveInfo.GetDrives()
            .Where(d => d.IsReady)
            .Select(d => Entry(d.Name, d.RootDirectory.FullName))
            .ToList();

    private static List<FolderEntry> Subfolders(string path) =>
        new DirectoryInfo(path)
            .EnumerateDirectories()
            .Where(d => (d.Attributes & (FileAttributes.Hidden | FileAttributes.System)) == 0)
            .Select(d => Entry(d.Name, d.FullName))
            .OrderByDescending(e => e.IsBase)
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

    private static FolderEntry Entry(string name, string path)
    {
        bool isBase;
        try
        {
            isBase = File.Exists(System.IO.Path.Combine(path, "agents-kit.json"));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            isBase = false;
        }
        return new FolderEntry(name, path, isBase, isBase ? BasesEndpoints.CountCopies(path) : null);
    }
}
