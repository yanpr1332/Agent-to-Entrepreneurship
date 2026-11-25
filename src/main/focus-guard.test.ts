import {afterEach,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {FocusGuardController,parseFocusGuardStart,isFocusDistraction,
  type FocusGuardPlatform,type FocusWindowControl} from "./focus-guard";

let exit:()=>void=()=>{};
let registrations=0,unregistrations=0;
let time=0;
class TestWindow implements FocusWindowControl{
  full=false;top=false;destroyed=false;fails=false;
  isDestroyed(){return this.destroyed;}
  isFullScreen(){return this.full;}
  isAlwaysOnTop(){return this.top;}
  setFullScreen(v:boolean){if(this.fails)throw Error("fullscreen unavailable");this.full=v;}
  setAlwaysOnTop(v:boolean){this.top=v;}
  focus(){}
}
function fixture(probe:()=>Promise<string|null>=async()=> "Safari",register=true){
  const platform:FocusGuardPlatform={
    registerEmergencyShortcut(callback){registrations++;exit=callback;return register;},
    unregisterEmergencyShortcut(){unregistrations++;},
  };
  const owner=new TestWindow();
  const guard=new FocusGuardController(platform,probe,()=>1_700_000_000_000+time,
    ()=>time);
  return {guard,owner};
}
const request=(mode:"monitor"|"shield"="shield")=>({
  sessionId:randomUUID(),durationSeconds:60,mode,
  listMode:"block" as const,appNames:["Safari"],
});
afterEach(()=>{time=0;exit=()=>{};registrations=0;unregistrations=0;});
describe("FOC-003/004 opt-in fail-open application guard",()=>{
  it("rejects arbitrary paths and malformed lists, never starts without explicit UI intent",()=>{
    const valid=request();
    for(const bad of [
      {...valid,appNames:["Safari","safari"]},{...valid,appNames:[""]},
      {...valid,appNames:["Safari\nSystem Events"]},
      {...valid,durationSeconds:10801},{...valid,durationSeconds:0},
      {...valid,mode:"root-kill"},{...valid,sourcePath:"/private"},
      {...valid,sessionId:"../../config"}, {...valid,listMode:"all"},
    ])expect(()=>parseFocusGuardStart(bad)).toThrow();
    expect(parseFocusGuardStart(valid)).toMatchObject(valid);
  });
  it("enables a reversible fullscreen focus window and supports emergency exit",async()=>{
    const {guard,owner}=fixture();
    owner.full=false;owner.top=false;
    const state=guard.start(request(),owner);
    expect(state).toMatchObject({active:true,mode:"shield"});
    expect(owner).toMatchObject({full:true,top:true});
    await guard.checkForeground();
    expect(guard.status()).toMatchObject({
      monitor:"available",distraction:true,foregroundApp:"Safari",
    });
    exit();
    expect(guard.status()).toMatchObject({active:false,monitor:"idle"});
    expect(owner).toMatchObject({full:false,top:false});
    guard.stop();
    expect(registrations).toBe(1);
    expect(unregistrations).toBeGreaterThanOrEqual(1);
  });
  it("will fail open on OS permission issues without claiming restrictions",async()=>{
    const {guard,owner}=fixture(async()=>null);
    guard.start(request("monitor"),owner);
    await guard.checkForeground();
    expect(guard.status()).toMatchObject({
      monitor:"unavailable",distraction:false,foregroundApp:null,
    });
    expect(owner).toMatchObject({full:false,top:false});
    guard.close();
  });
  it("expires automatically by monotonic clock, restoring prior window state",()=>{
    const {guard,owner}=fixture();
    owner.top=true;owner.full=true;
    guard.start(request(),owner);
    time=61_000;
    expect(guard.status().active).toBe(false);
    expect(owner).toMatchObject({top:true,full:true});
  });
  it("does not trap when native shortcut or fullscreen permissions fail",()=>{
    const a=fixture(async()=>null,false);
    expect(()=>a.guard.start(request(),a.owner)).toThrow("Emergency");
    expect(a.owner.full).toBe(false);
    const b=fixture();
    b.owner.fails=true;
    expect(()=>b.guard.start(request(),b.owner)).toThrow("could not start safely");
    expect(b.guard.status().active).toBe(false);
  });
  it("advisory blacklist/allowlist excludes recovery facilities",()=>{
    expect(isFocusDistraction("Safari",["Safari"],"block")).toBe(true);
    expect(isFocusDistraction("Chrome",["Safari"],"allow")).toBe(true);
    expect(isFocusDistraction("Safari",["Safari"],"allow")).toBe(false);
    expect(isFocusDistraction("Task Manager",["Task Manager"],"block")).toBe(false);
    expect(isFocusDistraction("Finder",["Safari"],"allow")).toBe(false);
    expect(isFocusDistraction("",["Safari"],"allow")).toBe(false);
    expect(isFocusDistraction("Chrome",[],"allow")).toBe(false);
  });
  it("never leaks stale asynchronous foreground results to the next session",async()=>{
    let resolve:(name:string)=>void=()=>{};
    const probe=vi.fn(()=>new Promise<string>(r=>{resolve=r;}));
    const {guard,owner}=fixture(probe);
    guard.start(request("monitor"),owner);
    guard.stop();
    guard.start(request("monitor"),owner);
    resolve("Safari");
    await Promise.resolve();
    expect(guard.status().distraction).toBe(false);
    guard.close();
  });
});
