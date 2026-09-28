using System.Diagnostics;

namespace AgentsKitWeb.Api.Tests;

internal static class TestGit
{
    /// <summary>Прогоняет git в каталоге прогона; ненулевой код — провал теста с текстом ошибки.</summary>
    public static void Run(string workingDirectory, params string[] args)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        using var process = TestProcess.Start(startInfo);
        var stderr = process.StandardError.ReadToEnd();
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"git {string.Join(' ', args)}: {stderr}");
    }

    /// <summary>Заводит репозиторий с одним пустым коммитом — копию, которую git отдаст строкой таблицы.</summary>
    public static string Repository(string path)
    {
        Directory.CreateDirectory(path);
        Run(path, "init", "-b", "dev");
        Run(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
        return path;
    }
}
