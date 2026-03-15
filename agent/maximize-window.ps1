param([string]$TitlePrefix, [int]$TimeoutSec = 10)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class MaximizeHelper {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public const int SW_MAXIMIZE = 3;

    public static IntPtr FindWindowByTitlePrefix(string prefix) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.Length > 0 && title.Contains("Antigravity") && title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $hwnd = [MaximizeHelper]::FindWindowByTitlePrefix($TitlePrefix)
    if ($hwnd -ne [IntPtr]::Zero) {
        [MaximizeHelper]::ShowWindow($hwnd, [MaximizeHelper]::SW_MAXIMIZE)
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
