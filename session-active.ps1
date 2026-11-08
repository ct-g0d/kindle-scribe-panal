# Prints 1 if this Windows session is the one in use, else 0. run.js asks this before each push, so with several
# accounts signed in only the one on screen drives the Kindle.
# "In use": an active Remote Desktop session wins (with a loopback RDP the console just shows the RDP window),
# otherwise the active console session. Switched-away and disconnected sessions are not active.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Wts {
    [DllImport("wtsapi32.dll")] static extern bool WTSEnumerateSessions(IntPtr h, int r, int v, out IntPtr info, out int count);
    [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr h, int id, int cls, out IntPtr buf, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
    [StructLayout(LayoutKind.Sequential)] struct Info { public int Id; public IntPtr Station; public int State; }
    const int Active = 0, ClientProtocolType = 16, Rdp = 2;
    public static int InUse() {
        IntPtr info; int count; int console = -1, rdp = -1;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out info, out count)) return -1;
        int size = Marshal.SizeOf(typeof(Info));
        for (int i = 0; i < count; i++) {
            var s = (Info)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + i * size), typeof(Info));
            if (s.State != Active || s.Id == 0) continue;
            IntPtr buf; int bytes; int proto = 0;
            if (WTSQuerySessionInformation(IntPtr.Zero, s.Id, ClientProtocolType, out buf, out bytes)) {
                proto = Marshal.ReadInt16(buf); WTSFreeMemory(buf);
            }
            if (proto == Rdp) { if (rdp < 0) rdp = s.Id; } else if (console < 0) console = s.Id;
        }
        WTSFreeMemory(info);
        return rdp >= 0 ? rdp : console;
    }
}
"@
$inUse = [Wts]::InUse()
# -1: couldn't tell; push anyway rather than go dark
if ($inUse -lt 0 -or $inUse -eq (Get-Process -Id $PID).SessionId) { "1" } else { "0" }
