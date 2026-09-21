using System.Text.Json;

namespace AgentsKitWeb.Api.Flow;

/// <summary>Пресет стадии флоу: готовая стадия, которую оператор добавляет во флоу любого проекта.</summary>
public sealed record StepPreset(string Id, string Title, string Executor, string Output, string? Skip, string? Description);

/// <summary>
/// Пресеты шагов в presets.json профиля оператора, рядом с bases.json: список свой у оператора и общий
/// для всех проектов, а не в базах — поэтому его хранит панель. Начинается пустым.
/// </summary>
public sealed class PresetsStore(string file)
{
    private readonly Lock _lock = new();

    /// <summary>presets.json в каталоге файла настроек: прогон, задавший свой BasesFile, не тронет профиль.</summary>
    public static string FileBeside(string basesFile) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(basesFile))!, "presets.json");

    public IReadOnlyList<StepPreset> List()
    {
        lock (_lock)
            return Read();
    }

    /// <summary>Сохраняет шаг как пресет; такой же шаг уже в списке — отдаёт его, второй раз не пишет.</summary>
    public StepPreset Add(FlowStage step)
    {
        var skip = string.IsNullOrWhiteSpace(step.Skip) ? null : step.Skip.Trim();
        var description = string.IsNullOrWhiteSpace(step.Description) ? null : step.Description.Replace("\r\n", "\n").Trim('\n');
        var preset = new StepPreset(Guid.NewGuid().ToString("N"), step.Title.Trim(), step.Executor.Trim(), step.Output.Trim(), skip, description);

        lock (_lock)
        {
            var presets = Read();
            if (presets.FirstOrDefault(p => Same(p, preset)) is { } existing)
                return existing;
            Write([.. presets, preset]);
        }
        return preset;
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            var presets = Read();
            var left = presets.Where(p => p.Id != id).ToList();
            if (left.Count == presets.Count)
                return false;
            Write(left);
        }
        return true;
    }

    private static bool Same(StepPreset a, StepPreset b) =>
        a.Title == b.Title && a.Executor == b.Executor && a.Output == b.Output && a.Skip == b.Skip && a.Description == b.Description;

    private List<StepPreset> Read()
    {
        if (!File.Exists(file))
            return [];
        using var stream = File.OpenRead(file);
        return JsonSerializer.Deserialize<PresetsFile>(stream, JsonOptions)?.Presets ?? [];
    }

    private void Write(List<StepPreset> presets)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var temp = file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new PresetsFile(presets), JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed record PresetsFile(List<StepPreset> Presets);
}
