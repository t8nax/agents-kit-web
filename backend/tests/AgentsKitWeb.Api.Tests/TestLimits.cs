using System.Runtime.CompilerServices;
using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

internal static class TestLimits
{
    /// <summary>
    /// Сроки панели прогон держит с запасом: на перегруженной машине git по копии не укладывался в срок
    /// панели, строка копии уходила в ошибку, и тесты краснели без поломки (B-142). Панель для оператора
    /// живёт со своим сроком.
    /// </summary>
    [ModuleInitializer]
    internal static void Widen() => GitWorktrees.Timeout = TimeSpan.FromSeconds(30);
}
