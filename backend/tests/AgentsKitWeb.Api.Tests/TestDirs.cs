namespace AgentsKitWeb.Api.Tests;

internal static class TestDirs
{
    /// <summary>
    /// Удаляет каталог теста, повторяя до 30 с, пока его держат: сразу после выхода процесса, запущенного
    /// панелью, каталог может держать посторонний — по-видимому, антивирус, проверяющий свежие скрипты, — и уборка
    /// с первой попытки изредка краснела на исправном коде (B-229, B-250). <paramref name="release"/> идёт перед
    /// каждой попыткой — отпустить то, что держит сам тест.
    /// </summary>
    internal static void Delete(string directory, Action? release = null)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            release?.Invoke();
            try
            {
                Directory.Delete(directory, recursive: true);
                return;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                              && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(500);
            }
        }
    }
}
