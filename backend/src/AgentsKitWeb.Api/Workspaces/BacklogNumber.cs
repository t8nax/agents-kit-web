using System.Text;
using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Workspaces;

/// <summary>
/// Номер записи бэклога по правилу кита: буквы проекта и число, «ORD-12». Буквы — латиница и цифры,
/// первый знак буква, не больше десяти знаков. В номере, набранном руками, регистр и кириллические
/// двойники латинских букв ничего не значат: «в-7» и «В-7» — тот же номер, что «B-7».
/// </summary>
public static partial class BacklogNumber
{
    [GeneratedRegex(@"^(?<letters>[A-Z][A-Z0-9]{0,9})-\d+$")]
    private static partial Regex Format { get; }

    // Кириллические буквы, которые пишутся как латинские, — в прописном виде.
    private static readonly Dictionary<char, char> Twins = new()
    {
        ['А'] = 'A', ['В'] = 'B', ['Е'] = 'E', ['К'] = 'K', ['М'] = 'M', ['Н'] = 'H',
        ['О'] = 'O', ['Р'] = 'P', ['С'] = 'C', ['Т'] = 'T', ['Х'] = 'X',
    };

    /// <summary>Номер в виде кита — латиницей и прописными; не номер — null.</summary>
    public static string? Normalize(string text)
    {
        var latin = new StringBuilder(text.Length);
        foreach (var c in text.Trim().ToUpperInvariant())
            latin.Append(Twins.TryGetValue(c, out var twin) ? twin : c);
        var number = latin.ToString();
        return Format.IsMatch(number) ? number : null;
    }

    /// <summary>Буквы номера в виде кита: «ORD-12» → «ORD».</summary>
    public static string Letters(string number) => Format.Match(number).Groups["letters"].Value;

    /// <summary>Число номера: «ORD-12» → 12.</summary>
    public static long Value(string number) =>
        long.TryParse(number[(number.LastIndexOf('-') + 1)..], out var value) ? value : 0;
}
