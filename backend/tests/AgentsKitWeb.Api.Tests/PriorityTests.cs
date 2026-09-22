using System.Diagnostics;

namespace AgentsKitWeb.Api.Tests;

public class PriorityTests
{
    [Fact]
    public void TestRun_IsBelowNormal()
    {
        Assert.Equal(ProcessPriorityClass.BelowNormal, Process.GetCurrentProcess().PriorityClass);
    }

    [Fact]
    public void TestRun_IsNotPowerThrottled()
    {
        Assert.True(TestPriority.ThrottlingOff());
    }

    [Fact]
    public void ProcessStartedByTests_IsBelowNormal()
    {
        var startInfo = new ProcessStartInfo("ping", "-n 30 127.0.0.1") { RedirectStandardOutput = true };
        using var process = Process.Start(startInfo)!;
        try
        {
            Assert.Equal(ProcessPriorityClass.BelowNormal, process.PriorityClass);
        }
        finally
        {
            process.Kill();
            process.WaitForExit();
        }
    }
}
