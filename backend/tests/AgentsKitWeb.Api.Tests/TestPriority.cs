using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace AgentsKitWeb.Api.Tests;

internal static class TestPriority
{
    /// <summary>
    /// Прогон тестов уступает процессор панели оператора и остальным программам (B-188); процессы,
    /// которые запускают тесты, наследуют приоритет. Одного приоритета мало: Windows 11 держит такой
    /// процесс на энергоэффективных ядрах, и на свободной машине прогон шёл медленнее, чем с обычным
    /// приоритетом. С отказом от энергосбережения он идёт быстрее прежнего.
    /// </summary>
    [ModuleInitializer]
    internal static void Lower()
    {
        Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
        if (!OperatingSystem.IsWindows())
            return;
        var state = new PowerThrottlingState { Version = PowerThrottlingCurrentVersion, ControlMask = PowerThrottlingExecutionSpeed, StateMask = 0 };
        if (!SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, ref state, Marshal.SizeOf<PowerThrottlingState>()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Прогон тестов не отказался от энергосбережения");
    }

    /// <summary>Отказался ли процесс прогона от энергосбережения: Windows сама его не включит.</summary>
    internal static bool ThrottlingOff()
    {
        var state = new PowerThrottlingState { Version = PowerThrottlingCurrentVersion };
        if (!GetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, ref state, Marshal.SizeOf<PowerThrottlingState>()))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return (state.ControlMask & PowerThrottlingExecutionSpeed) != 0 && (state.StateMask & PowerThrottlingExecutionSpeed) == 0;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PowerThrottlingState info, int size);
}
