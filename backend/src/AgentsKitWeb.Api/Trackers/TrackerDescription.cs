using System.Text;
using System.Text.RegularExpressions;
using AgentsKitWeb.Api.Bases;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Trackers;

/// <summary>
/// Описание трекера проекта — tracker.md корня базы — таким, каким его правит окно «Трекер проекта с Чудо-Юдо»
/// (B-293): три строки раздела «## Где задачи» и слова пяти разделов кита. Where — слова «Где задачи» под строками,
/// Backlog — «Показ бэклога», Take — «Взятие задачи», Closed — «Задача закрыта», Move — «Вынос записи бэклога».
/// Форму держит раскладка кита (reference/base-layout.md, «Трекер»); панель пишет её так, чтобы сверка кита
/// не нашла в файле красного.
/// </summary>
public sealed record TrackerDescription(
    string Tracker = "",
    string Server = "",
    string Project = "",
    string Where = "",
    string Backlog = "",
    string Take = "",
    string Closed = "",
    string Move = "");

/// <summary>Что в tracker.md вне полей окна: заголовок «# …», текст над первым разделом, разделы не из таблицы кита.</summary>
public sealed record TrackerFrame(string? Header, string Intro, string Extra);

/// <summary>Трекер из таблицы трекеров кита: имя, как его пишет /tracker, и шаблон проекта на значение целиком.</summary>
public sealed record KnownTracker(string Name, Regex ProjectPattern, string ProjectFault);

public static partial class TrackerDescriptions
{
    public const string WhereSection = "Где задачи";
    public const string BacklogSection = "Показ бэклога";
    public const string TakeSection = "Взятие задачи";
    public const string ClosedSection = "Задача закрыта";
    public const string MoveSection = "Вынос записи бэклога";

    /// <summary>
    /// Трекеры, которые панель заводит, — все четыре из таблицы кита: описание нужно сессиям агентов, а не только
    /// панели, ответ оператора на B-293.
    /// </summary>
    public static readonly IReadOnlyList<KnownTracker> Known =
    [
        new("GitHub", GitHubProject(), "Проект GitHub — владелец и репозиторий через «/»"),
        new("GitLab", GitLabProject(), "Проект GitLab — группа, подгруппы и проект через «/»"),
        new("Jira", JiraProject(), "Ключ проекта Jira — прописные латинские буквы, цифры и «_», первая — буква"),
        new("YouTrack", YouTrackProject(), "ID проекта YouTrack — латинские буквы, цифры и «_», первая — буква"),
    ];

    /// <summary>Трекер таблицы по имени без регистра; не из таблицы — null.</summary>
    public static KnownTracker? Find(string name) =>
        Known.FirstOrDefault(k => k.Name.Equals(name.Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Имя трекера, которым заголовок памяти начинает задачу трекера — «GitHub #37», «Jira PAY-7»: из строк описания,
    /// а сломаны в нём сервер или проект — из одной строки «трекер:»; трекер из таблицы — в написании кита, чтобы
    /// «github» и «GitHub» не расходились (ревью B-303). tracker.md нет, он не прочитан или трекер не назван — null.
    /// </summary>
    public static string? NameOf(BaseLayout layout)
    {
        string text;
        try
        {
            text = File.ReadAllText(layout.TrackerFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        var name = Workspaces.Tracker.Parse(text).Name ?? Parse(text).Tracker.Trim();
        return name.Length == 0 ? null : Find(name)?.Name ?? name;
    }

    /// <summary>
    /// Описание из текста tracker.md. Разделы — по заголовкам «##» вне блоков кода, слова раздела — как в файле,
    /// без пустых строк по краям; строки трекера, сервера и проекта — начало «Где задачи» до первой пустой строки или
    /// слов, как их разбирает сверка кита. Разделов не из таблицы и текста над первым разделом окно не показывает.
    /// </summary>
    public static TrackerDescription Parse(string text)
    {
        var sections = new Dictionary<string, List<string>>();
        List<string>? current = null;
        var fence = false;
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            if (!fence && Workspaces.Tracker.Heading().Match(line) is { Success: true } heading)
            {
                current = sections.TryGetValue(heading.Groups[1].Value, out var known) ? known : [];
                sections.TryAdd(heading.Groups[1].Value, current);
                continue;
            }
            if (line.StartsWith("```", StringComparison.Ordinal))
                fence = !fence;
            current?.Add(line);
        }

        string Body(string name) => sections.TryGetValue(name, out var lines) ? Trim(lines) : "";

        // Строки «ключ: значение» в начале раздела кит читает до первой пустой строки или прозы. Из них окно берёт три
        // своих; прочие — «доска: …» или проза с адресом, где двоеточие есть всегда, — остаются словами раздела,
        // иначе запись описания стёрла бы их молча (ревью B-293).
        var where = sections.TryGetValue(WhereSection, out var whereLines) ? whereLines : [];
        var keys = new Dictionary<string, string>();
        var rest = new List<string>();
        var at = 0;
        while (at < where.Count && where[at].Trim().Length == 0)
            at++;
        for (; at < where.Count; at++)
        {
            if (Workspaces.Tracker.Pair().Match(where[at]) is not { Success: true } pair)
                break;
            var key = pair.Groups[1].Value.ToLowerInvariant();
            if (key is "трекер" or "сервер" or "проект" && !keys.ContainsKey(key))
                keys[key] = pair.Groups[2].Value;
            else
                rest.Add(where[at]);
        }
        rest.AddRange(where.Skip(at));

        return new TrackerDescription(
            keys.GetValueOrDefault("трекер", ""),
            keys.GetValueOrDefault("сервер", ""),
            keys.GetValueOrDefault("проект", ""),
            Trim(rest),
            Body(BacklogSection),
            Body(TakeSection),
            Body(ClosedSection),
            Body(MoveSection));
    }

    /// <summary>
    /// Текст tracker.md в форме кита: заголовок «# &lt;проект&gt; — трекер» (или прежний заголовок файла), «## Где задачи» с тремя строками, пустой
    /// строкой и словами, за ним остальные разделы в порядке таблицы. Имя трекера — как в таблице кита.
    /// </summary>
    public static string Serialize(TrackerDescription description, string project, TrackerFrame? frame = null)
    {
        var name = Find(description.Tracker)?.Name ?? description.Tracker.Trim();
        var text = new StringBuilder()
            .Append(frame?.Header is { } header ? $"{header.TrimEnd()}\n\n" : $"# {project} — трекер\n\n");
        if (frame?.Intro is { Length: > 0 } intro)
            text.Append(intro).Append("\n\n");
        text
            .Append($"## {WhereSection}\n\n")
            .Append($"трекер: {name}\n")
            .Append($"сервер: {description.Server.Trim()}\n")
            .Append($"проект: {description.Project.Trim()}\n");
        if (Clean(description.Where).Length > 0)
            text.Append('\n').Append(Trim(description.Where)).Append('\n');
        foreach (var (section, body) in new[]
                 {
                     (BacklogSection, description.Backlog),
                     (TakeSection, description.Take),
                     (ClosedSection, description.Closed),
                     (MoveSection, description.Move),
                 })
            text.Append($"\n## {section}\n\n").Append(Trim(body)).Append('\n');
        if (frame?.Extra is { Length: > 0 } extra)
            text.Append('\n').Append(extra).Append('\n');
        return text.ToString();
    }

    /// <summary>
    /// Что в файле вне полей окна: заголовок «# …» над первым разделом, текст между ним и первым разделом и разделы не
    /// из таблицы кита целиком. Запись описания переносит их как есть — панель не стирает того, чего не показывает
    /// (ревью B-293). Заголовки «#» и «##» внутри блоков кода — не заголовки, как у сверки кита.
    /// </summary>
    public static TrackerFrame Frame(string text)
    {
        string? header = null;
        var intro = new List<string>();
        var extra = new List<string>();
        var fence = false;
        var inSection = false;
        var foreign = false;
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            if (!fence && Workspaces.Tracker.Heading().Match(line) is { Success: true } heading)
            {
                inSection = true;
                foreign = !Table.Contains(heading.Groups[1].Value);
                if (foreign)
                    extra.Add(line);
                continue;
            }
            var fenceLine = line.StartsWith("```", StringComparison.Ordinal);
            if (!inSection)
            {
                if (header is null && !fence && !fenceLine && line.StartsWith("# ", StringComparison.Ordinal))
                    header = line;
                else
                    intro.Add(line);
            }
            else if (foreign)
                extra.Add(line);
            if (fenceLine)
                fence = !fence;
        }
        return new TrackerFrame(header, Trim(intro), Trim(extra));
    }

    private static readonly string[] Table = [WhereSection, BacklogSection, TakeSection, ClosedSection, MoveSection];

    /// <summary>
    /// Что в описании не примет сверка кита — по полю окна: tracker, server, project, where, backlog, take, closed,
    /// move. Пусто — описание можно писать.
    /// </summary>
    public static Dictionary<string, string> Faults(TrackerDescription description)
    {
        var faults = new Dictionary<string, string>();
        var known = Find(description.Tracker);
        if (known is null)
            faults["tracker"] = "Выберите трекер: GitHub, GitLab, Jira или YouTrack";

        var server = description.Server.Trim();
        if (server.Length == 0)
            faults["server"] = "Укажите адрес сервера";
        else if (!Workspaces.Tracker.IsServerAddress(server))
            faults["server"] = "Адрес сервера — http:// или https://, хост, порт и путь, без логина, пароля, запроса и фрагмента";

        var project = description.Project.Trim();
        if (project.Length == 0)
            faults["project"] = "Укажите проект";
        else if (known is not null && !known.ProjectPattern.IsMatch(project))
            faults["project"] = known.ProjectFault;

        foreach (var (field, body) in new[]
                 {
                     ("where", description.Where),
                     ("backlog", description.Backlog),
                     ("take", description.Take),
                     ("closed", description.Closed),
                     ("move", description.Move),
                 })
            if (Clean(body).Length == 0)
                faults[field] = "Раздел не может быть пустым";
            else if (body.ReplaceLineEndings("\n").Split('\n').Count(l => l.StartsWith("```", StringComparison.Ordinal)) % 2 != 0)
                // Кит считает ограды по всему файлу: незакрытая спрятала бы от него все разделы ниже (ревью B-293).
                faults[field] = "Блок кода, начатый строкой «```», не закрыт";
            else if (HasHeading(body))
                // Кит считает заголовок «##» вне блока кода началом своего раздела — не из таблицы, а значит, красным.
                faults[field] = "Строка, начатая с «##», открыла бы новый раздел: уберите её или сделайте заголовок «###»";
        // Строка ключа — одна строка файла: перевод строки в значении сломал бы разбор кита.
        foreach (var (field, value) in new[] { ("server", server), ("project", project) })
            if (value.Contains('\n') || value.Contains('\r'))
                faults[field] = "Значение — одна строка";
        return faults;
    }

    /// <summary>Сколько строк и разделов разошлось между двумя описаниями — для строки «В изменениях: …».</summary>
    public static (int Lines, int Sections) Changed(TrackerDescription before, TrackerDescription after)
    {
        var lines = new[]
        {
            (before.Tracker, after.Tracker), (before.Server, after.Server), (before.Project, after.Project),
        }.Count(p => !Same(p.Item1, p.Item2));
        var sections = new[]
        {
            (before.Where, after.Where), (before.Backlog, after.Backlog), (before.Take, after.Take),
            (before.Closed, after.Closed), (before.Move, after.Move),
        }.Count(p => !Same(p.Item1, p.Item2));
        return (lines, sections);
    }

    /// <summary>Одно и то же значение поля: без пробелов по краям и разницы в переводах строк.</summary>
    public static bool Same(string a, string b) =>
        Trim(a.ReplaceLineEndings("\n")) == Trim(b.ReplaceLineEndings("\n"));

    /// <summary>Слова раздела без HTML-комментариев — пустоту раздела кит считает так же.</summary>
    private static string Clean(string body) => Workspaces.Tracker.Comment().Replace(body, "").Trim();

    private static bool HasHeading(string body)
    {
        var fence = false;
        foreach (var line in body.ReplaceLineEndings("\n").Split('\n'))
        {
            if (line.StartsWith("```", StringComparison.Ordinal))
                fence = !fence;
            else if (!fence && Workspaces.Tracker.Heading().IsMatch(line))
                return true;
        }
        return false;
    }

    private static string Trim(string text) => Trim(text.ReplaceLineEndings("\n").Split('\n').ToList());

    private static string Trim(List<string> lines)
    {
        var start = 0;
        var end = lines.Count;
        while (start < end && lines[start].Trim().Length == 0)
            start++;
        while (end > start && lines[end - 1].Trim().Length == 0)
            end--;
        return string.Join("\n", lines.Skip(start).Take(end - start).Select(l => l.TrimEnd()));
    }

    [GeneratedRegex(@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
    private static partial Regex GitHubProject();

    [GeneratedRegex(@"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$")]
    private static partial Regex GitLabProject();

    [GeneratedRegex(@"^[A-Z][A-Z0-9_]+$")]
    private static partial Regex JiraProject();

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_]*$")]
    private static partial Regex YouTrackProject();
}
