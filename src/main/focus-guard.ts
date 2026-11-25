import {performance} from "node:perf_hooks";
import type {FocusGuardStartInput,FocusGuardStatus,FocusGuardListMode}
  from "../shared/local-model";
import {parseTaskId} from "../shared/local-model";

/** Native operations are isolated behind a tiny interface, so migrations,
 * permission errors, headless CI, and OS hotkeys cannot trap users. */
export interface FocusWindowControl {
  isDestroyed():boolean;
  isFullScreen():boolean;
  isAlwaysOnTop():boolean;
  setFullScreen(value:boolean):void;
  setAlwaysOnTop(value:boolean):void;
  focus():void;
}
export type ForegroundAppProbe=()=>Promise<string|null>;
export interface FocusGuardPlatform {
  registerEmergencyShortcut(callback:()=>void):boolean;
  unregisterEmergencyShortcut():void;
}
const EXIT_SHORTCUT="CommandOrControl+Shift+F12";
const MAX_NAMES=20;
const BANNED_CONTROL=/[\u0000-\u001f\u007f]/;
export function parseFocusGuardStart(raw:unknown):FocusGuardStartInput {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("Invalid focus protection input");
  const r=raw as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!==
    "appNames,durationSeconds,listMode,mode,sessionId"||
    !Number.isSafeInteger(r.durationSeconds)||(r.durationSeconds as number)<1||
    (r.durationSeconds as number)>180*60||
    !["off","monitor","shield"].includes(r.mode as string)||
    !["block","allow"].includes(r.listMode as string)||
    !Array.isArray(r.appNames)||r.appNames.length>MAX_NAMES||
    r.appNames.some((n:unknown)=>typeof n!=="string"||n.length<1||
      n.length>80||BANNED_CONTROL.test(n)||n.trim()!==n)||
    new Set((r.appNames as string[]).map(x=>x.toLocaleLowerCase())).size!==r.appNames.length)
    throw Error("Invalid focus protection options");
  return {sessionId:parseTaskId(r.sessionId),
    durationSeconds:r.durationSeconds as number,
    mode:r.mode as FocusGuardStartInput["mode"],
    listMode:r.listMode as FocusGuardListMode,
    appNames:[...(r.appNames as string[])]};
}
export function isFocusDistraction(
  appName:string,names:readonly string[],mode:FocusGuardListMode,
):boolean{
  const actual=appName.trim().toLocaleLowerCase();
  if(!actual)return false;
  // Never classify the host application or common OS recovery facilities
  // as distracting, regardless of user lists. Monitoring is advisory only.
  if(["study anchor","finder","explorer","windowserver","loginwindow",
    "taskmgr","task manager","activity monitor","system settings",
    "system preferences","securityhealthsystray"].includes(actual))
    return false;
  const match=names.some(n=>n.toLocaleLowerCase()===actual);
  return mode==="block"?match:names.length>0&&!match;
}

/** Process-local lease, never persisted or resumed after app restart. Safe
 * release is idempotent and always happens on timeout, close or app quit. */
export class FocusGuardController {
  private current:FocusGuardStartInput|null=null;
  private owner:FocusWindowControl|null=null;
  private until=0;
  private expiresAt=0;
  private before:{full:boolean;top:boolean}|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private poller:ReturnType<typeof setInterval>|null=null;
  private generation=0;
  private monitor:FocusGuardStatus["monitor"]="idle";
  private foregroundApp:string|null=null;
  private distraction=false;
  private warning:string|null=null;

  constructor(private readonly platform:FocusGuardPlatform,
    private readonly foreground:ForegroundAppProbe,
    private readonly clock:()=>number=()=>Date.now(),
    private readonly monotonic:()=>number=()=>performance.now()){}

  start(raw:unknown,owner:FocusWindowControl):FocusGuardStatus{
    const requested=parseFocusGuardStart(raw);
    if(requested.mode==="off")throw Error("Disabled protection cannot start");
    if(this.current)throw Error("Another focus protection session is active");
    if(owner.isDestroyed())throw Error("The focus window is no longer available");
    if(!this.platform.registerEmergencyShortcut(()=>this.stop())){
      throw Error("Emergency exit shortcut is unavailable; protection was not enabled");
    }
    this.current=requested;this.owner=owner;
    this.before={full:owner.isFullScreen(),top:owner.isAlwaysOnTop()};
    this.monitor="checking";this.foregroundApp=null;this.distraction=false;
    this.warning="监测仅提醒，不能保证阻止其他程序。可随时紧急退出。";
    this.until=this.monotonic()+requested.durationSeconds*1000;
    this.expiresAt=this.clock()+requested.durationSeconds*1000;
    this.generation++;
    try{
      if(requested.mode==="shield"){
        // No kiosk, no accessibility hijack, no OS hotkey interception.
        owner.setFullScreen(true);
        owner.setAlwaysOnTop(true);
        owner.focus();
      }
      this.timer=setTimeout(()=>this.stop(),requested.durationSeconds*1000);
      this.poller=setInterval(()=>{void this.checkForeground();},4000);
      void this.checkForeground();
      return this.status();
    }catch{
      this.stop();
      throw Error("Focus window protection could not start safely");
    }
  }
  async checkForeground():Promise<void>{
    if(!this.current||this.monotonic()>=this.until){this.stop();return;}
    const generation=this.generation;
    try{
      const name=await this.foreground();
      if(generation!==this.generation||!this.current)return;
      if(name===null||name.trim()===""){
        this.monitor="unavailable";this.foregroundApp=null;
        this.distraction=false;
        this.warning="当前系统未授权或不支持前台程序检测；没有实施程序拦截。";
      }else{
        this.monitor="available";this.foregroundApp=name.slice(0,80);
        this.distraction=isFocusDistraction(name,
          this.current.appNames,this.current.listMode);
        this.warning=this.distraction
          ?"检测到名单内的非专注程序。这里只提醒，不会强制结束或阻断程序。"
          :null;
      }
    }catch{
      if(generation!==this.generation)return;
      this.monitor="unavailable";this.distraction=false;
      this.foregroundApp=null;
      this.warning="前台程序检测失败或权限不足；没有实施程序拦截。";
    }
  }
  status():FocusGuardStatus{
    if(this.current&&this.monotonic()>=this.until)this.stop();
    return {active:this.current!==null,
      mode:this.current?.mode??"off",
      endsAt:this.current?new Date(this.expiresAt).toISOString():null,
      monitor:this.current?this.monitor:"idle",
      foregroundApp:this.current?this.foregroundApp:null,
      distraction:this.current&&this.distraction||false,
      warning:this.current?this.warning:null,
      safeExitShortcut:EXIT_SHORTCUT};
  }
  stop():FocusGuardStatus{
    this.generation++;
    if(this.timer)clearTimeout(this.timer);
    if(this.poller)clearInterval(this.poller);
    this.timer=null;this.poller=null;
    const owner=this.owner,before=this.before;
    this.owner=null;this.current=null;this.before=null;
    this.until=0;this.expiresAt=0;
    this.monitor="idle";this.distraction=false;
    this.foregroundApp=null;this.warning=null;
    try{
      if(owner&&!owner.isDestroyed()&&before){
        // Independent best-effort restoration: a failing always-on-top API
        // must not prevent the fullscreen release attempt.
        try{owner.setAlwaysOnTop(before.top);}catch{/* OS may be closing */}
        try{owner.setFullScreen(before.full);}catch{/* OS may be closing */}
      }
    }finally{this.platform.unregisterEmergencyShortcut();}
    return this.status();
  }
  close():void{this.stop();}
}
