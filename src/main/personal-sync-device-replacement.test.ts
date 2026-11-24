import {afterEach,describe,expect,it,vi} from "vitest";
import {LocalStore} from "./local-store";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PersonalSyncService} from "./personal-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER_OWNER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const stores:Array<{close:()=>void}>=[];
function setup(){
  const tasks=new LocalStore(":memory:"),calendar=new FixedCalendarStore(":memory:");
  stores.push(tasks,calendar);
  const device=tasks.getOrCreatePersonalSyncDevice(OWNER);
  tasks.advancePersonalSyncCursor(OWNER,"12");
  return {tasks,calendar,device};
}
function cloud(){
  let owner=OWNER;
  return {
    currentUserId:vi.fn(()=>owner),
    changeOwner:(next:string)=>{owner=next;},
    revokePersonalSyncDevice:vi.fn(async()=>true),
    registerPersonalSyncDevice:vi.fn(async()=>({ownerId:OWNER,deviceId:"",createdAt:"",lastSeenAt:""})),
    applyPersonalSyncOperation:vi.fn(),
    pullPersonalSyncChanges:vi.fn(async(_device:string,cursor:string)=>({
      changes:[],nextCursor:cursor,hasMore:false,
    })),
  };
}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("ALPHA-SYNC-002F explicit device replacement",()=>{
  it("revokes only the current owner device, rotates its ID and preserves its committed cursor",async()=>{
    const {tasks,calendar,device}=setup();
    const other=tasks.getOrCreatePersonalSyncDevice(OTHER_OWNER);
    const remote=cloud(),service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const review=service.reviewDeviceReplacement();
    expect(review).toMatchObject({eligible:true,reason:null});
    expect(review.reviewToken).toMatch(/^[0-9a-f-]{36}$/);
    const result=await service.replaceDevice({reviewToken:review.reviewToken,confirmation:true});
    expect(result).toEqual({replaced:true});
    expect(remote.revokePersonalSyncDevice).toHaveBeenCalledOnce();
    expect(remote.revokePersonalSyncDevice).toHaveBeenCalledWith(device.deviceId);
    expect(remote.registerPersonalSyncDevice).not.toHaveBeenCalled();
    expect(remote.applyPersonalSyncOperation).not.toHaveBeenCalled();
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toMatchObject({cursor:"12"});
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER).deviceId).not.toBe(device.deviceId);
    expect(tasks.getOrCreatePersonalSyncDevice(OTHER_OWNER)).toEqual(other);
    await expect(service.replaceDevice({reviewToken:review.reviewToken,confirmation:true}))
      .rejects.toThrow("expired");
  });

  it("refuses unconfirmed, extra-field and unreviewed requests without network effects",async()=>{
    const {tasks,calendar,device}=setup();
    const remote=cloud(),service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const review=service.reviewDeviceReplacement();
    for(const bad of [
      {reviewToken:review.reviewToken,confirmation:false},
      {reviewToken:review.reviewToken,confirmation:true,ownerId:OTHER_OWNER},
      {reviewToken:device.deviceId,confirmation:true},
    ])await expect(Promise.resolve().then(()=>service.replaceDevice(bad))).rejects.toThrow();
    expect(remote.revokePersonalSyncDevice).not.toHaveBeenCalled();
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
  });

  it("blocks replacement with pending personal or manual calendar operations",()=>{
    const {tasks,calendar}=setup();
    const remote=cloud(),service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const task=tasks.createTask({title:"Needs local upload"});
    tasks.setTaskSyncEnabled(task.id,true,OWNER);
    expect(service.reviewDeviceReplacement()).toMatchObject({eligible:false,reviewToken:null});
    tasks.setTaskSyncEnabled(task.id,false,OWNER);
    const event=calendar.create({title:"Offline lesson",day:"2026-11-25",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    calendar.setManualEventSyncEnabled(event.id,true,OWNER);
    expect(service.reviewDeviceReplacement()).toMatchObject({eligible:false,reviewToken:null});
    expect(remote.revokePersonalSyncDevice).not.toHaveBeenCalled();
  });

  it("blocks replacement with held conflicts even if the outbox is empty",()=>{
    const {tasks,calendar}=setup();
    tasks.recordPersonalSyncConflicts(OWNER,[{
      entityType:"personal-task",entityId:"3babcb78-c10d-4f4e-ab3e-f47f6ad72447",
      localOperationId:null,localAction:null,localPayload:null,remoteVersion:1,
      remotePayload:{title:"Server conflict",description:"",dueDate:null,priority:"normal",completed:false},
      remoteDeleted:false,remoteUpdatedAt:"2026-11-24T10:00:00.000Z",
      reason:"local-entity-not-eligible",
    }]);
    const service=new PersonalSyncService(cloud() as unknown as SharedCloudClient,tasks,calendar);
    expect(service.reviewDeviceReplacement()).toMatchObject({eligible:false,reviewToken:null});
  });

  it("keeps the old device when cloud revocation fails and consumes review token",async()=>{
    const {tasks,calendar,device}=setup();
    const remote=cloud();
    remote.revokePersonalSyncDevice.mockRejectedValueOnce(Error("Service offline"));
    const service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const review=service.reviewDeviceReplacement();
    await expect(service.replaceDevice({reviewToken:review.reviewToken,confirmation:true}))
      .rejects.toThrow("Service offline");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
    await expect(service.replaceDevice({reviewToken:review.reviewToken,confirmation:true}))
      .rejects.toThrow("expired");
  });

  it("does not rotate when owner changes during cloud revocation",async()=>{
    const {tasks,calendar,device}=setup(),remote=cloud();
    let finish:(value:boolean)=>void=()=>{};
    remote.revokePersonalSyncDevice.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    const service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const review=service.reviewDeviceReplacement();
    const pending=service.replaceDevice({reviewToken:review.reviewToken,confirmation:true});
    expect(service.hasInFlightRun()).toBe(true);
    await expect(service.syncNow()).rejects.toThrow("replacement");
    remote.changeOwner(OTHER_OWNER);
    finish(true);
    await expect(pending).rejects.toThrow("account changed");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
    expect(service.hasInFlightRun()).toBe(false);
  });

  it("keeps local data when a manual event is queued during asynchronous revocation",async()=>{
    const {tasks,calendar,device}=setup(),remote=cloud();
    let finish:(value:boolean)=>void=()=>{};
    remote.revokePersonalSyncDevice.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    const service=new PersonalSyncService(remote as unknown as SharedCloudClient,tasks,calendar);
    const review=service.reviewDeviceReplacement();
    const job=service.replaceDevice({reviewToken:review.reviewToken,confirmation:true});
    const event=calendar.create({title:"New edit while waiting",day:"2026-11-25",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    calendar.setManualEventSyncEnabled(event.id,true,OWNER);
    finish(true);
    await expect(job).rejects.toThrow("calendar edit");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
    expect(calendar.countManualCalendarSyncOutbox(OWNER)).toBe(1);
  });

  it("rejects stale device/cursor compare-and-swap and nonempty task outbox at the store boundary",()=>{
    const {tasks,device}=setup();
    expect(()=>tasks.rotatePersonalSyncDevice(OWNER,device.deviceId,"13")).toThrow("changed");
    const task=tasks.createTask({title:"queued"});
    tasks.setTaskSyncEnabled(task.id,true,OWNER);
    expect(()=>tasks.rotatePersonalSyncDevice(OWNER,device.deviceId,"12")).toThrow("pending");
    expect(tasks.getOrCreatePersonalSyncDevice(OWNER)).toEqual(device);
  });
});
