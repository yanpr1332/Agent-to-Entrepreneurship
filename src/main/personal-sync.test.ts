import {afterEach,describe,expect,it,vi} from "vitest";
import {LocalStore} from "./local-store";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PersonalSyncService} from "./personal-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";
import type {PersonalSyncChange} from "../shared/personal-sync-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const ENTITY="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const stores:Array<{close:()=>void}>=[];
function setup(){
  const tasks=new LocalStore(":memory:");
  const calendar=new FixedCalendarStore(":memory:");
  stores.push(tasks,calendar);
  return {tasks,calendar};
}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("ALPHA-SYNC-002D manual personal transfer orchestration",()=>{
  it("registers the owner device, pushes explicitly enrolled tasks, then pulls and commits the cursor",async()=>{
    const {tasks,calendar}=setup();
    const task=tasks.createTask({title:"Local opt-in task"});
    tasks.setTaskSyncEnabled(task.id,true,OWNER);
    const remote:PersonalSyncChange={cursor:"1",entityType:"personal-task",entityId:task.id,
      version:1,payload:{title:"Local opt-in task",description:"",dueDate:null,
        priority:"normal",completed:false},deleted:false,updatedAt:"2026-11-24T01:00:00.000Z"};
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"accepted" as const,serverVersion:1,cursor:"1"})),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string,limit:number)=>limit===1
        ? {changes:[],nextCursor:cursor,hasMore:false}
        : cursor==="0"
          ? {changes:[remote],nextCursor:"1",hasMore:false}
          : {changes:[],nextCursor:cursor,hasMore:false}),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const result=await service.syncNow();
    expect(cloud.registerPersonalSyncDevice).toHaveBeenCalledOnce();
    expect(cloud.applyPersonalSyncOperation).toHaveBeenCalledOnce();
    expect(cloud.pullPersonalSyncChanges).toHaveBeenCalledWith(
      tasks.getOrCreatePersonalSyncDevice(OWNER).deviceId,"0",200);
    expect(result).toMatchObject({ownerId:OWNER,pushed:1,pulled:1,pullPages:1,
      pending:0,conflicts:0,cursor:"1",hasMore:false});
    expect(tasks.listPersonalSyncOutbox(OWNER)).toEqual([]);
    expect(tasks.listPersonalSyncEnrollments(OWNER)).toMatchObject([{serverVersion:1}]);
  });

  it("pushes and acknowledges an explicitly enrolled manual calendar event",async()=>{
    const {tasks,calendar}=setup();
    const event=calendar.create({title:"Manual remote class",day:"2026-11-25",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    calendar.setManualEventSyncEnabled(event.id,true,OWNER);
    const change:PersonalSyncChange={cursor:"1",entityType:"manual-calendar-event",
      entityId:event.id,version:1,payload:{title:event.title,day:event.day,
        startMinute:event.startMinute,durationMinutes:event.durationMinutes,seriesId:null},
      deleted:false,updatedAt:"2026-11-24T01:00:00.000Z"};
    const applied:unknown[]=[];
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async(operation:unknown)=>{
        applied.push(operation);
        return {status:"accepted" as const,serverVersion:1,cursor:"1"};
      }),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string,limit:number)=>limit===1
        ? {changes:[],nextCursor:cursor,hasMore:false}
        : {changes:[change],nextCursor:"1",hasMore:false}),
    } as unknown as SharedCloudClient;
    const result=await new PersonalSyncService(cloud,tasks,calendar).syncNow();
    expect(applied).toMatchObject([{entityType:"manual-calendar-event",entityId:event.id,action:"upsert"}]);
    expect(result).toMatchObject({pushed:1,pulled:1,pending:0,cursor:"1"});
    expect(calendar.listManualCalendarSyncEnrollments(OWNER)).toMatchObject([
      {eventId:event.id,serverVersion:1},
    ]);
  });

  it("persists remote conflicts and advances the cursor without overwriting local edits",async()=>{
    const {tasks,calendar}=setup();
    const first:PersonalSyncChange={cursor:"1",entityType:"personal-task",entityId:ENTITY,version:1,
      payload:{title:"Initial remote",description:"",dueDate:null,priority:"normal",completed:false},
      deleted:false,updatedAt:"2026-11-24T01:00:00.000Z"};
    tasks.applyRemotePersonalTaskChanges(OWNER,[first]);
    tasks.updateTask({id:ENTITY,title:"Local offline edit"});
    const remote:PersonalSyncChange={...first,cursor:"2",version:2,
      payload:{title:"Other device edit",description:"",dueDate:null,priority:"high",completed:true},
      updatedAt:"2026-11-24T01:05:00.000Z"};
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"conflict" as const,serverVersion:2,cursor:"2"})),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string,limit:number)=>limit===1
        ? {changes:[],nextCursor:cursor,hasMore:false}
        : {changes:[remote],nextCursor:"2",hasMore:false}),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const result=await service.syncNow();
    expect(result).toMatchObject({pushed:0,pushConflicts:1,pulled:1,conflicts:1,pending:1,cursor:"2"});
    expect(tasks.listTasks()).toMatchObject([{id:ENTITY,title:"Local offline edit"}]);
    expect(tasks.listPersonalSyncConflicts(OWNER)).toMatchObject([
      {entityId:ENTITY,remoteVersion:2,localPayload:{title:"Local offline edit"},
        remotePayload:{title:"Other device edit"}},
    ]);
  });

  it("holds pending conflicts from upload, tracks a newer remote version, then rebases only after choice",async()=>{
    const {tasks,calendar}=setup();
    const first:PersonalSyncChange={cursor:"1",entityType:"personal-task",entityId:ENTITY,version:1,
      payload:{title:"Initial",description:"",dueDate:null,priority:"normal",completed:false},
      deleted:false,updatedAt:"2026-11-24T01:00:00.000Z"};
    tasks.applyRemotePersonalTaskChanges(OWNER,[first]);
    tasks.updateTask({id:ENTITY,title:"Local edit"});
    const pending=tasks.listPersonalSyncOutbox(OWNER)[0];
    const second:PersonalSyncChange={...first,cursor:"2",version:2,
      payload:{title:"Other device version 2",description:"",dueDate:null,
        priority:"high",completed:false},
      updatedAt:"2026-11-24T01:01:00.000Z"};
    tasks.recordPersonalSyncConflicts(OWNER,tasks.applyRemotePersonalTaskChanges(OWNER,[second]));
    const third:PersonalSyncChange={...second,cursor:"3",version:3,
      payload:{title:"Other device version 3",description:"",dueDate:null,
        priority:"high",completed:true},
      updatedAt:"2026-11-24T01:02:00.000Z"};
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"accepted" as const,serverVersion:4,cursor:"4"})),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>cursor==="0"?
        {changes:[third],nextCursor:"3",hasMore:false}:
        {changes:[],nextCursor:cursor,hasMore:false}),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const result=await service.syncNow();
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({pushed:0,pulled:1,pending:1,conflicts:1,cursor:"3"});
    expect(tasks.listTasks()).toMatchObject([{id:ENTITY,title:"Local edit"}]);
    expect(tasks.getPersonalSyncConflict(OWNER,"personal-task",ENTITY)).toMatchObject({remoteVersion:3,remotePayload:{title:"Other device version 3"}});
    expect(()=>service.resolveConflict({entityType:"personal-task",entityId:ENTITY,
      remoteVersion:2,localOperationId:pending.operationId,choice:"keep-local"})).toThrow("changed");
    expect(service.resolveConflict({entityType:"personal-task",entityId:ENTITY,
      remoteVersion:3,localOperationId:pending.operationId,choice:"keep-local"}))
      .toMatchObject({resolved:true,choice:"keep-local"});
    expect(tasks.listPersonalSyncOutbox(OWNER)).toMatchObject([{baseVersion:3,action:"upsert"}]);
    const secondRun=await service.syncNow();
    expect(secondRun.pushed).toBe(1);
    expect(cloud.applyPersonalSyncOperation).toHaveBeenCalledOnce();
    expect(tasks.listPersonalSyncOutbox(OWNER)).toEqual([]);
  });

  it("refreshes pending edit identity and disables resolution after consent is revoked",async()=>{
    const {tasks,calendar}=setup();
    const first:PersonalSyncChange={cursor:"1",entityType:"personal-task",entityId:ENTITY,
      version:1,payload:{title:"Base",description:"",dueDate:null,priority:"normal",completed:false},
      deleted:false,updatedAt:"2026-11-24T01:00:00.000Z"};
    tasks.applyRemotePersonalTaskChanges(OWNER,[first]);
    tasks.updateTask({id:ENTITY,title:"First local draft"});
    const change:PersonalSyncChange={...first,cursor:"2",version:2,
      payload:{title:"Cloud edit",description:"",dueDate:null,priority:"normal",completed:true},
      updatedAt:"2026-11-24T01:01:00.000Z"};
    tasks.recordPersonalSyncConflicts(OWNER,tasks.applyRemotePersonalTaskChanges(OWNER,[change]));
    const old=tasks.listPersonalSyncOutbox(OWNER)[0];
    tasks.updateTask({id:ENTITY,title:"Revised local draft"});
    const latest=tasks.listPersonalSyncOutbox(OWNER)[0];
    expect(latest.operationId).not.toBe(old.operationId);
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"accepted" as const,serverVersion:3,cursor:"3"})),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>({
        changes:cursor==="0"?[{...change,cursor:"3",version:3}]:[],
        nextCursor:cursor==="0"?"3":cursor,hasMore:false,
      })),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    expect(service.listConflicts()).toMatchObject([{
      localOperationId:latest.operationId,localPayload:{title:"Revised local draft"},
      remoteVersion:2,canResolve:true,
    }]);
    expect(()=>service.resolveConflict({entityType:"personal-task",entityId:ENTITY,
      remoteVersion:2,localOperationId:old.operationId,choice:"keep-local"})).toThrow("changed");
    tasks.setTaskSyncEnabled(ENTITY,false,OWNER);
    expect(service.listConflicts()).toMatchObject([{canResolve:false,remoteVersion:2}]);
    await service.syncNow();
    expect(cloud.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(service.listConflicts()).toMatchObject([{canResolve:false,remoteVersion:3}]);
    expect(tasks.listTasks()).toMatchObject([{id:ENTITY,title:"Revised local draft"}]);
  });

  it("does not upload a later queue item after the user revokes consent during an earlier request",async()=>{
    const {tasks,calendar}=setup();
    const first=tasks.createTask({title:"First queued task"});
    const revoked=tasks.createTask({title:"Consent revoked before upload"});
    tasks.setTaskSyncEnabled(first.id,true,OWNER,new Date("2026-11-24T01:00:00.000Z"));
    tasks.setTaskSyncEnabled(revoked.id,true,OWNER,new Date("2026-11-24T01:01:00.000Z"));
    let releaseFirst:(value:{status:"accepted";serverVersion:number;cursor:string})=>void=()=>{};
    let markStarted:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{markStarted=resolve;});
    const wait=new Promise<{status:"accepted";serverVersion:number;cursor:string}>(resolve=>{releaseFirst=resolve;});
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>{markStarted();return wait;}),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>({changes:[],nextCursor:cursor,hasMore:false})),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const run=service.syncNow();
    await started;
    tasks.setTaskSyncEnabled(revoked.id,false,OWNER);
    releaseFirst({status:"accepted",serverVersion:1,cursor:"1"});
    await run;
    expect(cloud.applyPersonalSyncOperation).toHaveBeenCalledOnce();
    expect(tasks.listPersonalSyncOutbox(OWNER)).toEqual([]);
    expect(tasks.listTasks()).toHaveLength(2);
  });

  it("coalesces concurrent manual sync clicks into one in-flight run",async()=>{
    const {tasks,calendar}=setup();
    let release:(value:{ownerId:string;deviceId:string;createdAt:string;lastSeenAt:string})=>void=()=>{};
    const wait=new Promise<{ownerId:string;deviceId:string;createdAt:string;lastSeenAt:string}>(resolve=>{release=resolve;});
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(()=>wait),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"accepted" as const,serverVersion:1,cursor:"1"})),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>({changes:[],nextCursor:cursor,hasMore:false})),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const first=service.syncNow(),second=service.syncNow();
    expect(second).toBe(first);
    expect(cloud.registerPersonalSyncDevice).toHaveBeenCalledOnce();
    const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
    release({ownerId:OWNER,deviceId:device.deviceId,
      createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"});
    await Promise.all([first,second]);
    expect(cloud.pullPersonalSyncChanges).toHaveBeenCalledOnce();
  });

  it("stops before acknowledging an in-flight request when the app is shutting down",async()=>{
    const {tasks,calendar}=setup();
    const task=tasks.createTask({title:"Retry safely after shutdown"});
    tasks.setTaskSyncEnabled(task.id,true,OWNER);
    let release:(value:{status:"accepted";serverVersion:number;cursor:string})=>void=()=>{};
    let markStarted:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{markStarted=resolve;});
    const wait=new Promise<{status:"accepted";serverVersion:number;cursor:string}>(resolve=>{release=resolve;});
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>{markStarted();return wait;}),
      pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>({changes:[],nextCursor:cursor,hasMore:false})),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    const run=service.syncNow();
    await started;
    expect(service.hasInFlightRun()).toBe(true);
    service.cancel();
    const idle=service.waitForIdle();
    release({status:"accepted",serverVersion:1,cursor:"1"});
    await expect(run).rejects.toThrow("stopped");
    await idle;
    expect(service.hasInFlightRun()).toBe(false);
    expect(tasks.listPersonalSyncOutbox(OWNER)).toHaveLength(1);
    expect(cloud.pullPersonalSyncChanges).not.toHaveBeenCalled();
  });

  it("does not advance the cursor when remote changes cannot be applied locally",async()=>{
    const {tasks,calendar}=setup();
    const cloud={
      currentUserId:vi.fn(()=>OWNER),
      registerPersonalSyncDevice:vi.fn(async(deviceId:string)=>({ownerId:OWNER,deviceId,
        createdAt:"2026-11-24T01:00:00.000Z",lastSeenAt:"2026-11-24T01:00:00.000Z"})),
      applyPersonalSyncOperation:vi.fn(async()=>({status:"accepted" as const,serverVersion:1,cursor:"1"})),
      pullPersonalSyncChanges:vi.fn(async()=>{throw Error("offline");}),
    } as unknown as SharedCloudClient;
    const service=new PersonalSyncService(cloud,tasks,calendar);
    await expect(service.syncNow()).rejects.toThrow("offline");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).cursor).toBe("0");
  });
});
