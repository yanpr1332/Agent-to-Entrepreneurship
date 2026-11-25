import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile);
/** Fixed, non-shell OS inspection. It cannot terminate apps, alter OS
 * permissions, inspect window contents, or install hooks. */
const WIN_FOREGROUND_SCRIPT=String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FocusForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$h=[FocusForeground]::GetForegroundWindow()
if($h -eq [IntPtr]::Zero){ exit 2 }
[uint32]$idValue=0
[void][FocusForeground]::GetWindowThreadProcessId($h,[ref]$idValue)
if($idValue -eq 0){ exit 2 }
(Get-Process -Id $idValue -ErrorAction Stop).ProcessName
`;
export async function getForegroundApplication():Promise<string|null>{
  try{
    if(process.platform==="win32"){
      const result=await exec("powershell.exe",[
        "-NoLogo","-NoProfile","-NonInteractive","-Command",WIN_FOREGROUND_SCRIPT,
      ],{timeout:2200,maxBuffer:4096,windowsHide:true});
      return result.stdout.trim().slice(0,80)||null;
    }
    if(process.platform==="darwin"){
      // Uses the user's existing OS accessibility consent; never attempts
      // to bypass TCC or request a privileged automation entitlement.
      const result=await exec("/usr/bin/osascript",[
        "-e",'tell application "System Events" to get name of first application process whose frontmost is true',
      ],{timeout:2200,maxBuffer:4096});
      return result.stdout.trim().slice(0,80)||null;
    }
  }catch{/* Permissions, foreground unavailable or timed out: fail open. */}
  return null;
}
