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

/// <summary>
/// Панели, которые тесты класса поднимают сами. Уборка класса останавливает их так же, как свою, —
/// через <see cref="TestHost.Stop"/>, а не Dispose фабрики, и до того, как стереть временные файлы.
/// </summary>
internal sealed class TestHosts : IDisposable
{
    private readonly List<WebApplicationFactory<Program>> _factories = [];

    public WebApplicationFactory<Program> Add(WebApplicationFactory<Program> factory)
    {
        lock (_factories)
            _factories.Add(factory);
        return factory;
    }

    public void Dispose()
    {
        lock (_factories)
            foreach (var factory in _factories)
                TestHost.Stop(factory);
    }
}
