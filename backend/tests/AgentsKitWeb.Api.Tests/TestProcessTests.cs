using System.Text.RegularExpressions;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Программа, запущенная тестом мимо TestProcess, открывала бы окно поверх работы оператора (B-254):
/// такой запуск ловится по исходникам тестов, окна прогон не видит.
/// </summary>
public sealed class TestProcessTests
{
    [Fact]
    public void Tests_StartProgramsOnlyThroughTestProcess()
    {
        var bare = new Regex(@"(?<![\w])Process\.Start\(");
        var offenders = Directory.EnumerateFiles(Sources(), "*.cs")
            .Where(file => Path.GetFileName(file) is not ("TestProcess.cs" or "TestProcessTests.cs"))
            .Where(file => bare.IsMatch(File.ReadAllText(file)))
            .Select(Path.GetFileName);

        Assert.Empty(offenders);
    }

    /// <summary>Каталог исходников тестов: прогон идёт из bin, а исходники — выше.</summary>
    private static string Sources()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "AgentsKitWeb.Api.Tests.csproj")))
                return directory.FullName;
        }
        throw new DirectoryNotFoundException("исходники тестов не найдены выше каталога прогона");
    }
}
