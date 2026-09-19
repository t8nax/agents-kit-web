using System.Text;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Performers;

/// <summary>
/// Имя исполнителя в профиле. Каталог субагентов Claude Code один на машину и плоский, поэтому имя
/// начинается приставкой проекта: без неё два проекта спорят за одно имя и затирают файл друг друга.
/// Оператор набирает имя без приставки и её не видит — панель дописывает её сама.
/// </summary>
public static class PerformerName
{
    /// <summary>
    /// Приставка проекта — слаг его названия. Латинских букв в названии нет — слаг имени папки базы;
    /// не вышло и оно — приставки нет, и такому проекту панель исполнителя не заводит: без приставки
    /// он слился бы с чужими в один список. Хвост «-knowledge» у базы знаний не про проект и уходит.
    /// </summary>
    public static string Prefix(string basePath)
    {
        var slug = Slug(ProjectName.Of(basePath));
        if (slug.Length == 0)
            slug = Slug(new DirectoryInfo(basePath.TrimEnd('\\', '/')).Name);
        return slug.EndsWith("-knowledge", StringComparison.Ordinal)
            ? slug[..^"-knowledge".Length]
            : slug;
    }

    /// <summary>Полное имя — то, как исполнителя зовут шаг флоу и файл на диске.</summary>
    public static string Full(string prefix, string name) => $"{prefix}-{name}";

    /// <summary>Имя без приставки — то, что видит оператор. Приставка чужая — исполнитель не этого проекта.</summary>
    public static string? Short(string prefix, string full) =>
        prefix.Length > 0 && full.StartsWith(prefix + "-", StringComparison.Ordinal) && full.Length > prefix.Length + 1
            ? full[(prefix.Length + 1)..]
            : null;

    /// <summary>Строчная латиница, цифры и дефис — то же, что годится в имя субагента.</summary>
    private static string Slug(string text)
    {
        var slug = new StringBuilder();
        foreach (var c in text.ToLowerInvariant())
        {
            if (char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c))
                slug.Append(c);
            else if (slug.Length > 0 && slug[^1] != '-')
                slug.Append('-');
        }
        return slug.ToString().Trim('-');
    }
}
