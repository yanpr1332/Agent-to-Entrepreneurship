import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LocalStore} from "./local-store";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PersonalSyncService} from "./personal-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";
import type {PersonalSyncChange} from "../shared/personal-sync-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const REMOTE_ID="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const active:Array<{close:()=>void}>=[];
function setup(){
  const tasks=new LocalStore(":memory:"),calendar=new FixedCalendarStore(":memory:");
  active.push(tasks,calendar);
  const local=tasks.createTask({title:"Pending local draft"});
  tasks.setTaskSyncEnabled(local.id,true,OWNER);
  const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
  tasks.advancePersonalSyncCursor(OWNER,"5");
  return {tasks,calendar,local,device};
}
afterEach(()=>{while(active.length)active.pop()!.close();});

const remote:PersonalSyncChange={
  cursor:"6",entityType:"personal-task",entityId:REMOTE_ID,
  version:1,deleted:false,updatedAt:"2026-11-24T10:00:00.000Z",
  payload:{title:"New remote task",description:"",dueDate:null,priority:"normal",completed:false},
};
function mockCloud(pull:SharedCloudClient["pullPersonalSyncChanges"]){
  return {
    currentUserId:vi.fn(()=>OWNER),
    registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({
      ownerId:OWNER,deviceId,createdAt:"2026-11-24T09:00:00.000Z",
      lastSeenAt:"2026-11-24T10:00:00.000Z",
    })),
    applyPersonalSyncOperation:vi.fn(async()=>({
      status:"accepted" as const,serverVersion:1,cursor:"6",
    })),
    pullPersonalSyncChanges:vi.fn(pull),
  } as unknown as SharedCloudClient;
}

describe("ALPHA-SYNC-002F cursor and device preflight",()=>{
  it("also preflights a zero cursor before sending a freshly queued local create",async()=>{
    const tasks=new LocalStore(":memory:"),calendar=new FixedCalendarStore(":memory:");
    active.push(tasks,calendar);
    const local=tasks.createTask({title:"Brand new local pending"});
    tasks.setTaskSyncEnabled(local.id,true,OWNER);
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    expect(device.cursor).toBe("0");
    const firstChange={...remote,cursor:"1"};
    const cloud=mockCloud(async()=>({changes:[firstChange],nextCursor:"1",hasMore:false}));
    const result=await new PersonalSyncService(cloud,tasks,calendar).syncNow();
    expect(cloud.pullPersonalSyncChanges).toHaveBeenNthCalledWith(1,device.deviceId,"0",1);
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({pushDeferred:true,pushed:0,pulled:1,pending:1,cursor:"1"});
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
  });

  it("pulls remote changes first and defers all uploads for a nonzero saved cursor",async()=>{
    const {tasks,calendar,local,device}=setup();
    const cloud=mockCloud(async()=>({changes:[remote],nextCursor:"6",hasMore:false}));
    const result=await new PersonalSyncService(cloud,tasks,calendar).syncNow();
    expect(cloud.pullPersonalSyncChanges).toHaveBeenNthCalledWith(1,device.deviceId,"5",1);
    expect(cloud.pullPersonalSyncChanges).toHaveBeenNthCalledWith(2,device.deviceId,"5",200);
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({pushDeferred:true,pushed:0,pulled:1,cursor:"6",pending:1});
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("6");
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(tasks.listTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({id:local.id,title:"Pending local draft"}),
      expect.objectContaining({id:REMOTE_ID,title:"New remote task"}),
    ]));
  });

  it("permits a normal upload when preflight confirms no unread remote changes",async()=>{
    const {tasks,calendar,device}=setup();
    const cloud=mockCloud(async(_device,cursor,limit)=>limit===1
      ?{changes:[],nextCursor:String(cursor),hasMore:false}
      :{changes:[{...remote,entityId:tasks.listTasks()[0].id}],nextCursor:"6",hasMore:false});
    const result=await new PersonalSyncService(cloud,tasks,calendar).syncNow();
    expect(cloud.pullPersonalSyncChanges).toHaveBeenNthCalledWith(1,device.deviceId,"5",1);
    expect(cloud.applyPersonalSyncOperation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({pushDeferred:false,pushed:1,pulled:1,pending:0,cursor:"6"});
    expect(tasks.listPersonalSyncOutbox(OWNER)).toEqual([]);
  });

  it("does not send any pending operation when the server rejects the saved cursor",async()=>{
    const {tasks,calendar}=setup();
    const cloud=mockCloud(async()=>{throw Error("Cloud request rejected (HTTP 400)");});
    await expect(new PersonalSyncService(cloud,tasks,calendar).syncNow())
      .rejects.toThrow("HTTP 400");
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("5");
  });

  it("does not upload after device registration is rejected or revoked",async()=>{
    const {tasks,calendar}=setup();
    const cloud=mockCloud(async()=>({changes:[],nextCursor:"5",hasMore:false}));
    vi.mocked(cloud.registerPersonalSyncDevice).mockRejectedValue(Error("Device revoked"));
    await expect(new PersonalSyncService(cloud,tasks,calendar).syncNow())
      .rejects.toThrow("Device revoked");
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(cloud.pullPersonalSyncChanges).not.toHaveBeenCalled();
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
  });

  it("refuses corrupted saved cursor and device ID before a network call",()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-sync-preflight-"));
    const path=join(dir,"tasks.sqlite");
    try{
      const initial=new LocalStore(path);
      initial.getOrCreatePersonalSyncDevice(OWNER);
      initial.close();
      const raw=new DatabaseSync(path);
      raw.prepare("UPDATE personal_sync_devices SET cursor=? WHERE owner_id=?").run("bad-cursor",OWNER);
      raw.close();
      const reopened=new LocalStore(path);
      expect(()=>reopened.getOrCreatePersonalSyncDevice(OWNER)).toThrow("Saved personal sync cursor");
      reopened.close();
      const rawAgain=new DatabaseSync(path);
      rawAgain.prepare("UPDATE personal_sync_devices SET cursor=?,device_id=? WHERE owner_id=?")
        .run("5","not-a-device",OWNER);
      rawAgain.close();
      const last=new LocalStore(path);
      expect(()=>last.getOrCreatePersonalSyncDevice(OWNER)).toThrow("Saved personal sync device");
      last.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
