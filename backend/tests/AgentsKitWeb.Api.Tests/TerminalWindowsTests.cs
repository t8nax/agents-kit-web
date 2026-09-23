using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Проверяется команда, которой панель открывает терминал: сам запуск в прогоне не идёт — он открыл бы
/// окно на машине оператора.
/// </summary>
public sealed class TerminalWindowsTests
{
    [Fact]
    public void WindowsTerminal_OpensPowerShellInTheCopyAttachedToTheSession()
    {
        var startInfo = WindowsTerminals.WindowsTerminal(@"D:\Projects\app", "7339dced");

        Assert.Equal("wt.exe", startInfo.FileName);
        Assert.Equal(@"D:\Projects\app", startInfo.WorkingDirectory);
        Assert.Equal(["-d", @"D:\Projects\app", "pwsh", "-NoExit", "-Command"], startInfo.ArgumentList.Take(5));
        Assert.StartsWith(@"claude attach 7339dced\; ", startInfo.ArgumentList[5]);
    }

    [Fact]
    public void PowerShellWindow_RunsInTheCopyAttachedToTheSession()
    {
        var startInfo = WindowsTerminals.PowerShellWindow(@"D:\Projects\app", "7339dced");

        Assert.Equal("pwsh.exe", startInfo.FileName);
        Assert.Equal(@"D:\Projects\app", startInfo.WorkingDirectory);
        Assert.Equal(["-NoExit", "-Command", WindowsTerminals.Command("7339dced")], startInfo.ArgumentList);
    }

    [Fact]
    public void Command_ClosesTheWindowOnlyWhenTheSessionIsGone()
    {
        Assert.Equal(
            "claude attach 7339dced; " +
            "try { if (@(claude agents --json | ConvertFrom-Json).id -notcontains '7339dced') { exit } } catch { }",
            WindowsTerminals.Command("7339dced"));
    }

    [Fact]
    public void WindowsTerminal_EscapesSemicolonsSoTheCommandStaysInOneTab()
    {
        var command = WindowsTerminals.WindowsTerminal(@"D:\Projects\app", "7339dced").ArgumentList[5];

        Assert.Equal(WindowsTerminals.Command("7339dced").Replace(";", @"\;"), command);
        Assert.DoesNotMatch(@"(?<!\\);", command);
    }

    [Fact]
    public void Terminal_KeepsTheWindowOfALiveSessionOpen()
    {
        Assert.Contains("-NoExit", WindowsTerminals.WindowsTerminal(@"D:\Projects\app", "7339dced").ArgumentList);
        Assert.Contains("-NoExit", WindowsTerminals.PowerShellWindow(@"D:\Projects\app", "7339dced").ArgumentList);
    }
}
