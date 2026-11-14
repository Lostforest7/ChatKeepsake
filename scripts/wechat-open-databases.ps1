$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Ask Windows which processes are using these specific database files.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WeChatDatabaseRestartManager {
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess {
        public int Pid;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartedAt;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int RmRegisterResources(uint handle, uint fileCount, string[] paths,
        uint appCount, IntPtr applications, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll", ExactSpelling = true)]
    private static extern int RmGetList(uint handle, out uint needed, ref uint count,
        [Out] ProcessInfo[] processes, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll", ExactSpelling = true)]
    private static extern int RmEndSession(uint handle);

    public static int[] ProcessesUsing(string[] paths) {
        uint handle;
        if (RmStartSession(out handle, 0, new StringBuilder(33)) != 0) return new int[0];
        try {
            if (RmRegisterResources(handle, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null) != 0) return new int[0];
            uint count = 0, needed, reasons = 0;
            int result = RmGetList(handle, out needed, ref count, null, ref reasons);
            for (int tries = 0; result == 234 && needed <= 256 && tries < 3; tries++) {
                count = needed;
                var processes = new ProcessInfo[count];
                result = RmGetList(handle, out needed, ref count, processes, ref reasons);
                if (result != 0) continue;
                var ids = new int[count];
                for (int i = 0; i < count; i++) ids[i] = processes[i].Process.Pid;
                return ids;
            }
            return new int[0];
        } finally {
            RmEndSession(handle);
        }
    }
}
'@

$groups = ConvertFrom-Json -InputObject $env:WECHAT_CHATS_TO_FILES_DB_PROBE
$matched = @()
for ($index = 0; $index -lt $groups.Count; $index++) {
    $files = [string[]]@($groups[$index].files | Where-Object { [IO.File]::Exists($_) })
    if ($files.Length -eq 0) { continue }
    foreach ($owner in [WeChatDatabaseRestartManager]::ProcessesUsing($files)) {
        $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($process.ProcessName -in 'Weixin','WeChat') {
            $matched += $index
            break
        }
    }
}
ConvertTo-Json -InputObject @($matched) -Compress
