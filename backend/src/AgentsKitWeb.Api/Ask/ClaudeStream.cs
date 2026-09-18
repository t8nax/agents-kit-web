using System.Text.Json;

namespace AgentsKitWeb.Api.Ask;

/// <summary>
/// Событие ответа на вопрос по базе, одной строкой NDJSON. Type: step — ход работы агента (Text);
/// answer — ответ (Text, Files — прочитанные файлы базы, DurationMs); error — ответа нет (Text — почему,
/// Output — что вывел агент).
/// </summary>
public sealed record AskEvent(
    string Type,
    string Text,
    IReadOnlyList<string>? Files = null,
    long? DurationMs = null,
    string? Output = null) : IAgentEvent;

/// <summary>
/// Разбор вывода `claude -p --output-format stream-json --verbose`: вызовы инструментов становятся строками
/// хода, итог — ответом или ошибкой. Формат задаёт Claude Code; строки, которых разбор не знает, пропускаются.
/// copyPath задан — агент работает в копии проекта: её файлы называются от копии, а файлы вне базы и копии
/// (правила кита в профиле) — одним именем.
/// </summary>
public sealed class ClaudeStream(string basePath, string? copyPath = null)
{
    private readonly List<string> _files = [];
    private readonly List<string> _unparsed = [];

    /// <summary>Итог агента уже пришёл — событием answer или error.</summary>
    public bool Finished { get; private set; }

    /// <summary>Строки stdout не в JSON: при сбое это и есть вывод агента.</summary>
    public string Unparsed => string.Join("\n", _unparsed);

    public IEnumerable<AskEvent> Read(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
            yield break;

        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(line);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            _unparsed.Add(line.Trim());
            yield break;
        }
        if (root.ValueKind != JsonValueKind.Object)
            yield break;

        switch (Text(root, "type"))
        {
            case "assistant":
                if (root.TryGetProperty("message", out var message)
                    && message.TryGetProperty("content", out var content)
                    && content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var part in content.EnumerateArray())
                    {
                        if (Text(part, "type") == "tool_use" && Step(part) is { } step)
                            yield return new AskEvent("step", step);
                    }
                }
                break;

            case "result":
                Finished = true;
                var text = Text(root, "result") ?? "";
                var duration = root.TryGetProperty("duration_ms", out var ms) && ms.TryGetInt64(out var value) ? value : (long?)null;
                var failed = root.TryGetProperty("is_error", out var isError) && isError.ValueKind == JsonValueKind.True
                    || Text(root, "subtype") != "success";
                yield return failed
                    ? new AskEvent("error", "Агент завершился с ошибкой", Output: text.Length > 0 ? text : Text(root, "subtype"))
                    : new AskEvent("answer", text, _files.ToList(), duration);
                break;
        }
    }

    private string? Step(JsonElement toolUse)
    {
        if (!toolUse.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object)
            return null;

        switch (Text(toolUse, "name"))
        {
            case "Read" when Text(input, "file_path") is { } file:
                var relative = Relative(file);
                if (!_files.Contains(relative, StringComparer.OrdinalIgnoreCase))
                    _files.Add(relative);
                return $"читает {relative}";
            case "Grep" when Text(input, "pattern") is { } pattern:
                var where = Text(input, "path") is { } path ? Relative(path) : Text(input, "glob");
                return where is null ? $"ищет «{pattern}»" : $"ищет «{pattern}» в {where}";
            case "Glob" when Text(input, "pattern") is { } glob:
                return $"ищет файлы {glob}";
            case "Edit" when Text(input, "file_path") is { } edited:
                return $"правит {Relative(edited)}";
            case "PowerShell" when Text(input, "command") is { } command:
                return command.Contains(" commit ", StringComparison.Ordinal) ? "коммитит бэклог" : "запускает команду";
            default:
                return null;
        }
    }

    private string Relative(string path)
    {
        if (!Path.IsPathFullyQualified(path))
            return path.Replace('\\', '/');
        if (copyPath is not null && !Inside(basePath, path))
            return Inside(copyPath, path) ? Path.GetRelativePath(copyPath, path).Replace('\\', '/') : Path.GetFileName(path);
        return Path.GetRelativePath(basePath, path).Replace('\\', '/');
    }

    private static bool Inside(string root, string path) =>
        path.StartsWith(root.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
