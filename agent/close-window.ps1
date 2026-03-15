param([string]$TitlePrefix)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WindowHelper {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public const uint WM_CLOSE = 0x0010;

    public static List<IntPtr> FindWindowsByTitlePrefix(string prefix) {
        var result = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

$windows = [WindowHelper]::FindWindowsByTitlePrefix("$TitlePrefix - Antigravity")
foreach ($w in $windows) {
    [WindowHelper]::PostMessage($w, [WindowHelper]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
}
