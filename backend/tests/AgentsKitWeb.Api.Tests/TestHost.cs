using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AgentsKitWeb.Api.Tests;

internal static class TestHost
{
    /// <summary>
    /// Останавливает панель так же, как останавливается настоящая: ждёт её фоновые службы и только
    /// потом гасит хост. Dispose фабрики их не ждёт, и фоновая проверка баз переживала тест —
    /// запущенный ею pwsh держал временные файлы, которые тест тут же стирал.
    /// </summary>
    public static void Stop(WebApplicationFactory<Program> factory)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            foreach (var service in factory.Services.GetServices<IHostedService>())
                service.StopAsync(deadline.Token).GetAwaiter().GetResult();
        }
        catch (ObjectDisposedException)
        {
            // Панель уже остановлена: тест погасил её сам, а следом это делает уборка класса.
            return;
        }
        factory.Dispose();
    }
}
