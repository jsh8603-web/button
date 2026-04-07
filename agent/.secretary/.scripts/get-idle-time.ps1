Add-Type @'
using System; using System.Runtime.InteropServices;
public class IdleTime {
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    public static int Get() {
        var info = new LASTINPUTINFO { cbSize = 8 };
        GetLastInputInfo(ref info);
        return (Environment.TickCount - (int)info.dwTime) / 1000;
    }
}
'@
[IdleTime]::Get()
