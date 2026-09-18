namespace AgentsKitWeb.Api.Tests;

internal static class TestKit
{
    /// <summary>
    /// Заводит каталог кита со скриптами-заглушками. Панель проверяет не правила кита, а то,
    /// как она их зовёт и показывает, поэтому функции кита подменяются своими телами.
    /// </summary>
    public static string Create(
        string path,
        string baseCheck = "",
        string linkState = "",
        string? worktreeAdd = null,
        string? worktreeRemove = null)
    {
        var scripts = Directory.CreateDirectory(Path.Combine(path, "scripts")).FullName;
        File.WriteAllText(Path.Combine(scripts, "base-check.ps1"), ". (Join-Path $PSScriptRoot 'link-state.ps1')\n" + baseCheck);
        File.WriteAllText(Path.Combine(scripts, "link-state.ps1"), linkState);
        if (worktreeAdd is not null)
            File.WriteAllText(Path.Combine(scripts, "worktree-add.ps1"), worktreeAdd);
        if (worktreeRemove is not null)
            File.WriteAllText(Path.Combine(scripts, "worktree-remove.ps1"), worktreeRemove);
        return path;
    }
}
