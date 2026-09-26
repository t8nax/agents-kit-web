using System.Diagnostics;

namespace AgentsKitWeb.Api.Tests;

/// <summary>
/// Запуск программ из тестов без окна, как панель запускает свои (decisions/base-access.md): у прогона
/// без своей консоли — из редактора — каждый git и pwsh теста открывал бы окно поверх работы (B-254).
/// Мимо него тесты программ не запускают — TestProcessTests.
/// </summary>
internal static class TestProcess
{
    public static Process Start(ProcessStartInfo startInfo)
    {
        // Через оболочку Windows окно не спрятать: такой запуск — ошибка теста, а не молча другой запуск.
        if (startInfo.UseShellExecute)
            throw new ArgumentException("тест запускает программы без оболочки: окно через неё не спрятать",
                nameof(startInfo));
        startInfo.CreateNoWindow = true;
        return Process.Start(startInfo)!;
    }
}
