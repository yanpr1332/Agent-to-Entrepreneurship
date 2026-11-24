import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LocalStore} from "./local-store";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PersonalSyncService} from "./personal-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";
import type {PersonalSyncPullPage} from "../shared/personal-sync-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const TASK="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const EVENT="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const STAMP="2026-11-24T12:00:00.000Z";
const page:PersonalSyncPullPage={
  changes:[
    {cursor:"1",entityType:"personal-task",entityId:TASK,version:1,
      payload:{title:"Remote task",description:"",dueDate:null,priority:"normal",completed:false},
      deleted:false,updatedAt:STAMP},
    {cursor:"2",entityType:"manual-calendar-event",entityId:EVENT,version:1,
      payload:{title:"Remote lesson",day:"2026-11-25",startMinute:540,durationMinutes:60,seriesId:null},
      deleted:false,updatedAt:STAMP},
  ],
  nextCursor:"2",hasMore:false,
};
const dirs:string[]=[];
const opened:Array<{close:()=>void}>=[];
function setup(){
  const dir=mkdtempSync(join(tmpdir(),"ate-sync-replay-"));
  dirs.push(dir);
  const taskPath=join(dir,"ate-local.sqlite"),calendarPath=join(dir,"ate-fixed-calendar.sqlite");
  const tasks=new LocalStore(taskPath),calendar=new FixedCalendarStore(calendarPath);
  opened.push(tasks,calendar);
  return {dir,taskPath,calendarPath,tasks,calendar};
}
function reopen(taskPath:string,calendarPath:string){
  const tasks=new LocalStore(taskPath),calendar=new FixedCalendarStore(calendarPath);
  opened.push(tasks,calendar);
  return {tasks,calendar};
}
function cloud(){
  return {
    currentUserId:vi.fn(()=>OWNER),
    registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({
      ownerId:OWNER,deviceId,createdAt:STAMP,lastSeenAt:STAMP,
    })),
    applyPersonalSyncOperation:vi.fn(async()=>({
      status:"accepted" as const,serverVersion:1,cursor:"2",
    })),
    pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string,limit:number)=>(
      cursor==="0"&&limit===200?page:{changes:[],nextCursor:cursor,hasMore:false}
    )),
    revokePersonalSyncDevice:vi.fn(async()=>true),
  };
}
afterEach(()=>{
  while(opened.length)opened.pop()!.close();
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});

describe("ALPHA-SYNC-002G durable cross-SQLite page replay",()=>{
  it("stages a page before either store and completes it after an actual SQLite reopen",async()=>{
    const {tasks,calendar,taskPath,calendarPath}=setup(),remote=cloud();
    const before=tasks.getOrCreatePersonalSyncDevice(OWNER);
    const spy=vi.spyOn(calendar,"applyRemoteManualCalendarChanges")
      .mockImplementationOnce(()=>{throw Error("Simulated calendar crash");});
    await expect(new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar).syncNow())
      .rejects.toThrow("Simulated calendar crash");
    expect(tasks.getPendingPersonalSyncPull(OWNER)).toMatchObject({
      deviceId:before.deviceId,fromCursor:"0",page:{nextCursor:"2",changes:[{entityId:TASK},{entityId:EVENT}]},
    });
    expect(tasks.listTasks()).toMatchObject([{id:TASK,title:"Remote task"}]);
    expect(calendar.list().some(e=>e.id===EVENT)).toBe(false);
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
    spy.mockRestore();
    calendar.close();tasks.close();opened.length=0;

    const recovered=reopen(taskPath,calendarPath);
    // The new cloud session exposes only "empty from cursor 2". Recovery
    // must not depend on downloading the interrupted page a second time.
    const resumed=await new PersonalSyncService(
      remote as unknown as SharedCloudClient,recovered.tasks,recovered.calendar).syncNow();
    expect(resumed).toMatchObject({recoveredPages:1,pushed:0,pulled:0,cursor:"2",pending:0});
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(recovered.tasks.getPendingPersonalSyncPull(OWNER)).toBeNull();
    expect(recovered.tasks.listTasks()).toHaveLength(1);
    expect(recovered.calendar.list().filter(e=>e.id===EVENT)).toHaveLength(1);
    expect(recovered.tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("2");
    expect(remote.pullPersonalSyncChanges).toHaveBeenLastCalledWith(before.deviceId,"2",200);
  });

  it("blocks new uploads while replaying an interrupted page and makes local edits conflicts",async()=>{
    const {tasks,calendar}=setup(),remote=cloud();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page);
    const local=tasks.createTask({title:"Another draft"});
    tasks.setTaskSyncEnabled(local.id,true,OWNER);
    // Recovery must finish before a preflight or a queued operation is uploaded.
    const result=await new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar).syncNow();
    expect(result).toMatchObject({recoveredPages:1,pushed:0,pushDeferred:true,cursor:"2"});
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(calendar.list().filter(e=>e.id===EVENT)).toHaveLength(1);
  });

  it("keeps the checkpoint and cursor after a conflict-record write fails, then retries",async()=>{
    const {tasks,calendar}=setup(),remote=cloud();
    const local=tasks.createTask({title:"Conflicting local task"});
    tasks.setTaskSyncEnabled(local.id,true,OWNER);
    const alternative={...page,changes:[{...page.changes[0],entityId:local.id}],nextCursor:"1"};
    remote.pullPersonalSyncChanges.mockImplementation(async(_device,cursor,limit)=>
      cursor==="0"?alternative:{changes:[],nextCursor:cursor,hasMore:false});
    const fail=vi.spyOn(tasks,"recordPersonalSyncConflicts")
      .mockImplementationOnce(()=>{throw Error("Conflict storage interrupted");});
    await expect(new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar).syncNow())
      .rejects.toThrow("Conflict storage interrupted");
    expect(tasks.getPendingPersonalSyncPull(OWNER)?.page.nextCursor).toBe("1");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
    fail.mockRestore();
    // On restart the same immutable page must be replayed and the conflict held.
    const second=await new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar).syncNow();
    expect(second.recoveredPages).toBe(1);
    expect(tasks.getPendingPersonalSyncPull(OWNER)).toBeNull();
    expect(tasks.listPersonalSyncConflicts(OWNER)).toMatchObject([
      {entityId:local.id,reason:"remote-change-while-local-pending",remoteVersion:1},
    ]);
  });

  it("rejects missing/changed device, duplicate staging and backward cursor completion",()=>{
    const {tasks}=setup();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    expect(()=>tasks.beginPersonalSyncPullPage(OWNER,"00000000-0000-4000-8000-000000000000","0",page))
      .toThrow("Device or cursor changed");
    tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page);
    expect(()=>tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page))
      .toThrow("unfinished");
    expect(()=>tasks.advancePersonalSyncCursor(OWNER,"2")).toThrow("checkpoint");
    expect(()=>tasks.finishPersonalSyncPullPage(OWNER,device.deviceId,"0","1"))
      .toThrow("checkpoint");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
    tasks.finishPersonalSyncPullPage(OWNER,device.deviceId,"0","2");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("2");
    expect(tasks.getPendingPersonalSyncPull(OWNER)).toBeNull();
  });

  it("never lets another owner consume or overwrite a pending page",()=>{
    const {tasks}=setup();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    const other=tasks.getOrCreatePersonalSyncDevice(OTHER);
    tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page);
    expect(tasks.getPendingPersonalSyncPull(OTHER)).toBeNull();
    expect(()=>tasks.finishPersonalSyncPullPage(OTHER,other.deviceId,"0","2"))
      .toThrow("checkpoint");
    expect(tasks.getPendingPersonalSyncPull(OWNER)?.fromCursor).toBe("0");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
  });

  it("blocks device replacement when a staged page is awaiting replay",()=>{
    const {tasks,calendar}=setup(),remote=cloud();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page);
    const service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    expect(service.reviewDeviceReplacement()).toMatchObject({eligible:false});
    expect(()=>tasks.rotatePersonalSyncDevice(OWNER,device.deviceId,"0"))
      .toThrow("Recover the interrupted");
    expect(remote.revokePersonalSyncDevice).not.toHaveBeenCalled();
  });

  it("refuses malformed persisted page and sends no network request",async()=>{
    const {tasks,calendar,taskPath,calendarPath}=setup(),remote=cloud();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",page);
    tasks.close();calendar.close();opened.length=0;
    const sqlite=new DatabaseSync(taskPath);
    sqlite.prepare("UPDATE personal_sync_pull_checkpoints SET page_json=? WHERE owner_id=?")
      .run('{"changes":"corrupted"}',OWNER);
    sqlite.close();
    const reopened=reopen(taskPath,calendarPath);
    await expect(new PersonalSyncService(remote as unknown as SharedCloudClient,
      reopened.tasks,reopened.calendar).syncNow()).rejects.toThrow("checkpoint is invalid");
    expect(remote.registerPersonalSyncDevice).not.toHaveBeenCalled();
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(reopened.tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
  });

  it("does not begin a checkpoint for empty, backwards or oversized pull pages",()=>{
    const {tasks}=setup();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    expect(()=>tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",
      {changes:[],nextCursor:"0",hasMore:false})).toThrow("Invalid personal sync checkpoint");
    expect(()=>tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"2",page))
      .toThrow("Invalid personal sync checkpoint");
    expect(tasks.getPendingPersonalSyncPull(OWNER)).toBeNull();
  });
});
