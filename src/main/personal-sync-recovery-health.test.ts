import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LocalStore} from "./local-store";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PersonalSyncService} from "./personal-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";
import type {PersonalSyncPullPage,PersonalSyncDeviceInspection,PersonalSyncReceiptLookup} from "../shared/personal-sync-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const REMOTE_ID="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const STAMP="2026-11-24T10:00:00.000Z";
const stores:Array<{close:()=>void}>=[];
const dirs:string[]=[];
function setup(){
  const tasks=new LocalStore(":memory:"),calendar=new FixedCalendarStore(":memory:");
  stores.push(tasks,calendar);
  return {tasks,calendar};
}
function cloud(){
  let owner=OWNER;
  return {
    currentUserId:vi.fn(()=>owner),
    changeOwner:(next:string)=>{owner=next;},
    inspectPersonalSyncDevice:vi.fn(async():Promise<PersonalSyncDeviceInspection>=>({deviceStatus:"active",serverCursor:"5"})),
    lookupPersonalSyncReceipt:vi.fn(async():Promise<PersonalSyncReceiptLookup>=>({status:"not-found",response:null})),
    registerPersonalSyncDevice:vi.fn(),
    applyPersonalSyncOperation:vi.fn(),
    pullPersonalSyncChanges:vi.fn(),
    revokePersonalSyncDevice:vi.fn(),
  };
}
function service(remote:ReturnType<typeof cloud>,stores:ReturnType<typeof setup>){
  return new PersonalSyncService(remote as unknown as SharedCloudClient,stores.tasks,stores.calendar);
}
const matched=(version=1)=>({status:"matched" as const,response:{
  status:"accepted" as const,serverVersion:version,cursor:String(version),
}});
const checkpoint:PersonalSyncPullPage={changes:[{
  cursor:"1",entityType:"personal-task",entityId:REMOTE_ID,version:1,
  payload:{title:"Recovered",description:"",dueDate:null,priority:"normal",completed:false},
  deleted:false,updatedAt:STAMP,
}],nextCursor:"1",hasMore:false};
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});

describe("ALPHA-SYNC-002H recovery status inspection",()=>{
  it("is read-only and does not silently initialize a never-synced owner",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    const result=await sync.inspectRecovery();
    expect(result).toMatchObject({status:"uninitialized",localCursor:null,serverCursor:null,
      taskPending:0,calendarPending:0,conflicts:0,pendingReplay:false});
    expect(st.tasks.peekPersonalSyncDevice(OWNER)).toBeNull();
    expect(remote.inspectPersonalSyncDevice).not.toHaveBeenCalled();
    expect(remote.registerPersonalSyncDevice).not.toHaveBeenCalled();
  });

  it("uses the current owner and returns active status without touching cursor",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    const device=st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const result=await sync.inspectRecovery();
    expect(remote.inspectPersonalSyncDevice).toHaveBeenCalledOnce();
    expect(remote.inspectPersonalSyncDevice).toHaveBeenCalledWith(device.deviceId);
    expect(result).toMatchObject({status:"active",localCursor:"0",serverCursor:"5"});
    expect(st.tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked","revoked",1],
    ["unregistered","unregistered",1],
    ["active","cursor-ahead",0],
  ] as const)("recognizes %s remote device/offset state as %s",async(remoteStatus,status,offset)=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    if(offset===0)st.tasks.advancePersonalSyncCursor(OWNER,"8");
    remote.inspectPersonalSyncDevice.mockResolvedValueOnce({
      deviceStatus:remoteStatus,serverCursor:"5",
    });
    expect(await sync.inspectRecovery()).toMatchObject({status,serverCursor:"5"});
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
  });

  it("returns an unavailable diagnosis when RPC is not deployed, preserving the local device",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    const device=st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    remote.inspectPersonalSyncDevice.mockRejectedValueOnce(Error("HTTP 404"));
    const result=await sync.inspectRecovery();
    expect(result).toMatchObject({status:"cloud-unavailable",localCursor:"0",serverCursor:null});
    expect(st.tasks.peekPersonalSyncDevice(OWNER)).toEqual(device);
  });

  it("blocks remote inspection of a corrupt local cursor with no network requests",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-recovery-corrupt-"));
    dirs.push(dir);
    const file=join(dir,"tasks.sqlite");
    let tasks=new LocalStore(file);
    tasks.getOrCreatePersonalSyncDevice(OWNER);
    tasks.close();
    const sqlite=new DatabaseSync(file);
    sqlite.prepare("UPDATE personal_sync_devices SET cursor=? WHERE owner_id=?").run("nope",OWNER);
    sqlite.close();
    tasks=new LocalStore(file);
    const calendar=new FixedCalendarStore(":memory:");
    stores.push(tasks,calendar);
    const remote=cloud();
    const result=await service(remote,{tasks,calendar}).inspectRecovery();
    expect(result).toMatchObject({status:"local-invalid",localCursor:null});
    expect(remote.inspectPersonalSyncDevice).not.toHaveBeenCalled();
  });

  it("refuses to inspect the server while a pull checkpoint must be replayed",async()=>{
    const st=setup(),remote=cloud();
    const device=st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    st.tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",checkpoint);
    const result=await service(remote,st).inspectRecovery();
    expect(result).toMatchObject({status:"pending-replay",localCursor:"0",pendingReplay:true});
    expect(remote.inspectPersonalSyncDevice).not.toHaveBeenCalled();
  });

  it("refuses a cloud account switch during asynchronous inspection",async()=>{
    const st=setup(),remote=cloud();
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    let resolve:(x:{deviceStatus:"active";serverCursor:string})=>void=()=>{};
    remote.inspectPersonalSyncDevice.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const job=service(remote,st).inspectRecovery();
    remote.changeOwner(OTHER);
    resolve({deviceStatus:"active",serverCursor:"5"});
    await expect(job).rejects.toThrow("account changed");
  });
});

describe("ALPHA-SYNC-002H exact receipt reconciliation",()=>{
  it("acknowledges matching task/calendar receipts and sends no sync mutations",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Potentially sent task"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    const event=st.calendar.create({title:"Potentially sent lesson",day:"2026-11-25",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    st.calendar.setManualEventSyncEnabled(event.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockImplementation(async()=>matched(1));
    const review=await sync.reviewReceipts();
    expect(review).toMatchObject({inspected:2,eligibleToAcknowledge:2,notFound:0,unresolved:0,pending:2,
      hasMore:false});
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(st.calendar.listManualCalendarSyncOutbox(OWNER)).toHaveLength(1);
    const r=await sync.reconcileReceipts({reviewToken:review.reviewToken,confirmation:true});
    expect(r).toMatchObject({inspected:2,acknowledged:2,notFound:0,unresolved:0,pending:0,
      hasMore:false});
    expect(remote.lookupPersonalSyncReceipt).toHaveBeenCalledTimes(2);
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(remote.registerPersonalSyncDevice).not.toHaveBeenCalled();
    expect(remote.pullPersonalSyncChanges).not.toHaveBeenCalled();
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toEqual([]);
    expect(st.calendar.listManualCalendarSyncOutbox(OWNER)).toEqual([]);
    expect(st.tasks.listPersonalSyncEnrollments(OWNER)[0].serverVersion).toBe(1);
    expect(st.calendar.listManualCalendarSyncEnrollments(OWNER)[0].serverVersion).toBe(1);
  });

  it("retains not-found and conflict receipts for normal future review",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    for(const name of ["Absent receipt","Conflict receipt"]){
      const t=st.tasks.createTask({title:name});
      st.tasks.setTaskSyncEnabled(t.id,true,OWNER);
    }
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce({status:"not-found",response:null});
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce({status:"matched",response:{
      status:"conflict",serverVersion:3,cursor:"3",
    }});
    const r=await sync.reviewReceipts();
    expect(r).toMatchObject({inspected:2,eligibleToAcknowledge:0,notFound:1,unresolved:1,pending:2,reviewToken:null});
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(2);
  });

  it("preflights all receipts before acknowledging any; mismatch aborts the whole pass",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    for(const title of ["One","Two"]){
      const t=st.tasks.createTask({title});
      st.tasks.setTaskSyncEnabled(t.id,true,OWNER);
    }
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce(matched());
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce({status:"mismatch",response:null});
    await expect(sync.reviewReceipts()).rejects.toThrow("differs");
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(2);
    expect(st.tasks.listPersonalSyncEnrollments(OWNER).every(x=>x.serverVersion===null)).toBe(true);
  });

  it("an unavailable RPC never clears the queue or sends an operation",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const t=st.tasks.createTask({title:"Keep pending"});
    st.tasks.setTaskSyncEnabled(t.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockRejectedValueOnce(Error("Cloud request rejected (HTTP 404)"));
    await expect(sync.reviewReceipts()).rejects.toThrow("HTTP 404");
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
  });

  it("reconciles an old accepted operation after local edits rotated its intent",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const t=st.tasks.createTask({title:"Before send"});
    st.tasks.setTaskSyncEnabled(t.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockImplementationOnce(async()=>{
      st.tasks.updateTask({id:t.id,title:"Edited while inspecting"});
      return matched(1);
    });
    await expect(sync.reviewReceipts()).rejects.toThrow("Local pending queue changed");
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toMatchObject([
      {entityId:t.id,baseVersion:null,action:"upsert"},
    ]);
    expect(st.tasks.listTasks().find(x=>x.id===t.id)?.title).toBe("Edited while inspecting");
  });

  it("cannot run concurrently with sync and requires current owner continuity",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const t=st.tasks.createTask({title:"Pending"});
    st.tasks.setTaskSyncEnabled(t.id,true,OWNER);
    let release:(r:{status:"not-found";response:null})=>void=()=>{};
    remote.lookupPersonalSyncReceipt.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const job=sync.reviewReceipts();
    expect(sync.hasInFlightRun()).toBe(true);
    await expect(sync.syncNow()).rejects.toThrow("reconciliation");
    remote.changeOwner(OTHER);
    release({status:"not-found",response:null});
    await expect(job).rejects.toThrow("account changed");
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
  });

  it("refuses reconciliation while a checkpoint is pending",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    const device=st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    st.tasks.beginPersonalSyncPullPage(OWNER,device.deviceId,"0",checkpoint);
    await expect(sync.reviewReceipts()).rejects.toThrow("checkpoint");
    expect(remote.lookupPersonalSyncReceipt).not.toHaveBeenCalled();
  });

  it("cannot confirm without the exact one-time token and an explicit true confirmation",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Await explicit confirmation"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce(matched());
    const preview=await sync.reviewReceipts();
    expect(preview.eligibleToAcknowledge).toBe(1);
    for(const input of [
      {reviewToken:preview.reviewToken,confirmation:false},
      {reviewToken:preview.reviewToken,confirmation:true,ownerId:OTHER},
    ])await expect(Promise.resolve().then(()=>sync.reconcileReceipts(input))).rejects.toThrow();
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
    await expect(sync.reconcileReceipts({reviewToken:REMOTE_ID,confirmation:true}))
      .rejects.toThrow("expired");
    await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
      .rejects.toThrow("expired");
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
  });

  it("expires a reviewed token after five minutes without clearing local pending state",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Expired confirmation"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValueOnce(matched());
    const preview=await sync.reviewReceipts();
    const now=vi.spyOn(Date,"now").mockReturnValue(Date.now()+6*60_000);
    try{
      await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
        .rejects.toThrow("expired");
    }finally{now.mockRestore();}
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
  });

  it("discards confirmation on cancel; a second attempt needs a fresh cloud preview",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Cancel review"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValue(matched());
    const preview=await sync.reviewReceipts();
    expect(sync.discardReceiptReview()).toEqual({cancelled:true});
    await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
      .rejects.toThrow("expired");
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
    const second=await sync.reviewReceipts();
    expect(second.reviewToken).not.toBe(preview.reviewToken);
  });

  it("refuses changed task outbox between preview and confirm, without changing local version",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Pre-review"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValue(matched());
    const preview=await sync.reviewReceipts();
    st.tasks.updateTask({id:task.id,title:"New local edit"});
    await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
      .rejects.toThrow("queue changed");
    expect(st.tasks.listPersonalSyncOutbox(OWNER)).toMatchObject([
      {entityId:task.id,baseVersion:null,action:"upsert"},
    ]);
  });

  it("refuses calendar outbox changes after preview and preserves both pending queues",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Pending task"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValue(matched());
    const preview=await sync.reviewReceipts();
    const event=st.calendar.create({title:"New calendar item",day:"2026-11-25",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    st.calendar.setManualEventSyncEnabled(event.id,true,OWNER);
    await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
      .rejects.toThrow("queue changed");
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
    expect(st.calendar.countManualCalendarSyncOutbox(OWNER)).toBe(1);
  });

  it("refuses a changed device/cursor and owner switch after the review",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Pending"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValue(matched());
    const preview=await sync.reviewReceipts();
    st.tasks.advancePersonalSyncCursor(OWNER,"1");
    await expect(sync.reconcileReceipts({reviewToken:preview.reviewToken,confirmation:true}))
      .rejects.toThrow("device changed");
    const later=await sync.reviewReceipts();
    remote.changeOwner(OTHER);
    await expect(sync.reconcileReceipts({reviewToken:later.reviewToken,confirmation:true}))
      .rejects.toThrow("expired or account changed");
    expect(st.tasks.countPersonalSyncOutbox(OWNER)).toBe(1);
  });

  it("does not allow sync to reuse a receipt review from a previous run",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    st.tasks.getOrCreatePersonalSyncDevice(OWNER);
    const task=st.tasks.createTask({title:"Pending"});
    st.tasks.setTaskSyncEnabled(task.id,true,OWNER);
    remote.lookupPersonalSyncReceipt.mockResolvedValue(matched());
    const review=await sync.reviewReceipts();
    remote.registerPersonalSyncDevice.mockResolvedValue({ownerId:OWNER,deviceId:"",createdAt:STAMP,lastSeenAt:STAMP});
    remote.pullPersonalSyncChanges.mockResolvedValue({changes:[],nextCursor:"0",hasMore:false});
    remote.applyPersonalSyncOperation.mockResolvedValue({status:"accepted",serverVersion:1,cursor:"1"});
    await sync.syncNow();
    await expect(sync.reconcileReceipts({reviewToken:review.reviewToken,confirmation:true}))
      .rejects.toThrow("expired");
  });

  it("never initializes a device merely to find receipts",async()=>{
    const st=setup(),remote=cloud(),sync=service(remote,st);
    await expect(sync.reviewReceipts()).rejects.toThrow("No local personal sync device");
    expect(st.tasks.peekPersonalSyncDevice(OWNER)).toBeNull();
    expect(remote.lookupPersonalSyncReceipt).not.toHaveBeenCalled();
  });
});
