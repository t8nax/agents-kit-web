using System.Diagnostics;

namespace AgentsKitWeb.Api.Tests;

internal static class TestProcess
{
    /// <summary>
    /// Запускает программу из теста без окна, как панель запускает свои (decisions/base-access.md): у прогона
    /// без своей консоли — из редактора — каждый git и pwsh теста открывал бы окно поверх работы (B-254).
    /// </summary>
    public static Process Start(ProcessStartInfo startInfo)
    {
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        return Process.Start(startInfo)!;
    }
}
