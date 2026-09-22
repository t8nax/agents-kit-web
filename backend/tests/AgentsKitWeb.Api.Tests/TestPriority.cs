using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace AgentsKitWeb.Api.Tests;

internal static class TestPriority
{
    /// <summary>
    /// Прогон тестов уступает процессор панели оператора и остальным программам (B-188); процессы,
    /// которые запускают тесты, наследуют приоритет. Одного приоритета мало: Windows 11 держит такой
    /// процесс на энергоэффективных ядрах, и на свободной машине прогон шёл 46 с вместо 38. С отказом
    /// от энергосбережения он идёт 27 с.
    /// </summary>
    [ModuleInitializer]
    internal static void Lower()
    {
        Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
        if (!OperatingSystem.IsWindows())
            return;
        var state = new PowerThrottlingState { Version = PowerThrottlingCurrentVersion, ControlMask = PowerThrottlingExecutionSpeed, StateMask = 0 };
        SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, ref state, Marshal.SizeOf<PowerThrottlingState>());
    }

    private const int ProcessPowerThrottling = 4;
    private const uint PowerThrottlingCurrentVersion = 1;
    private const uint PowerThrottlingExecutionSpeed = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct PowerThrottlingState
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);
}
