import { randomUUID } from "node:crypto";
import {
  parsePersonalSyncOperation, parsePersonalSyncResolutionRequest,
  parsePersonalSyncDeviceReplacementRequest,
  type PersonalSyncChange, type PersonalSyncConflict, type PersonalSyncConflictRecord,
  type PersonalSyncRunResult, type PersonalSyncDeviceReplacementReview, type PersonalSyncPullPage,
} from "../shared/personal-sync-contract";
import type { SharedCloudClient } from "./cloud/supabase-client";
import type { LocalStore } from "./local-store";
import type { FixedCalendarStore } from "./fixed-calendar-store";

type TaskOutbox=ReturnType<LocalStore["listPersonalSyncOutbox"]>[number]&{entityType:"personal-task"};
type CalendarOutbox=ReturnType<FixedCalendarStore["listManualCalendarSyncOutbox"]>[number]&{entityType:"manual-calendar-event"};
type PendingOutbox=TaskOutbox|CalendarOutbox;

const PUSH_LIMIT=100;
const PULL_PAGE_SIZE=200;
const MAX_PULL_PAGES_PER_RUN=10;

function deviceLabel():string{
  const platform=process.platform==="darwin"?"macOS":process.platform==="win32"?"Windows":
    process.platform==="linux"?"Linux":"Desktop";
  return "ATE Desktop ("+platform+")";
}

/**
 * Explicit, user-triggered personal sync. No timer or background worker is started here.
 * The authenticated owner is always read from the Main-process cloud session; Renderer
 * never supplies ownerId, deviceId, cursor, or operation envelopes.
 */
export class PersonalSyncService{
  private running:Promise<PersonalSyncRunResult>|null=null;
  private replacementRunning:Promise<{replaced:true}>|null=null;
  private replacementReview:{ownerId:string;deviceId:string;cursor:string;token:string}|null=null;
  private stopping=false;

  constructor(
    private readonly cloud:Pick<SharedCloudClient,
      "currentUserId"|"registerPersonalSyncDevice"|"applyPersonalSyncOperation"|"pullPersonalSyncChanges"|"revokePersonalSyncDevice">,
    private readonly tasks:LocalStore,
    private readonly calendar:FixedCalendarStore,
  ){}

  syncNow():Promise<PersonalSyncRunResult>{
    if(this.stopping)return Promise.reject(Error("Personal synchronization is stopping"));
    if(this.replacementRunning)return Promise.reject(Error("Device replacement is in progress"));
    if(this.running)return this.running;
    const job=this.performSync().finally(()=>{if(this.running===job)this.running=null;});
    this.running=job;
    return job;
  }


  /** The UI shows only current local intents; an edit after a prior conflict
   * rotates its operation ID. Reading the conflict list reconciles this metadata
   * without sending any data or changing the remote snapshot. */
  listConflicts():PersonalSyncConflictRecord[]{
    const ownerId=this.cloud.currentUserId();
    const records=this.tasks.listPersonalSyncConflicts(ownerId);
    if(!this.hasInFlightRun()){
      for(const conflict of records){
        if(conflict.reason!=="remote-change-while-local-pending"&&
          conflict.reason!=="remote-delete-while-local-pending")continue;
        const pending=conflict.entityType==="personal-task"
          ?this.tasks.getPersonalSyncPendingIntent(ownerId,conflict.entityId)
          :this.calendar.getManualCalendarPendingIntent(ownerId,conflict.entityId);
        if(pending)this.tasks.refreshPersonalSyncConflictLocal(
          ownerId,conflict.entityType,conflict.entityId,pending);
      }
    }
    return this.tasks.listPersonalSyncConflicts(ownerId).map(conflict=>{
      const pending=conflict.entityType==="personal-task"
        ?this.tasks.getPersonalSyncPendingIntent(ownerId,conflict.entityId)
        :this.calendar.getManualCalendarPendingIntent(ownerId,conflict.entityId);
      return {...conflict,canResolve:(
        conflict.reason==="remote-change-while-local-pending"||
        conflict.reason==="remote-delete-while-local-pending")&&
        Boolean(pending&&pending.operationId===conflict.localOperationId&&
          pending.action===conflict.localAction&&
          JSON.stringify(pending.payload?JSON.parse(pending.payload):null)===
            JSON.stringify(conflict.localPayload))};
    });
  }

  /**
   * Conflict decisions are explicit and guarded by the reviewed local operation
   * and remote version. No cloud account identity comes from the IPC payload.
   * Caller refreshes the remote cursor before invoking this synchronous method.
   */
  resolveConflict(raw:unknown):{resolved:true;choice:"keep-local"|"use-remote"}{
    if(this.stopping||this.hasInFlightRun())throw Error("Wait until personal sync is idle before resolving");
    const ownerId=this.cloud.currentUserId();
    const input=parsePersonalSyncResolutionRequest(raw);
    const conflict=this.tasks.getPersonalSyncConflict(ownerId,input.entityType,input.entityId);
    if(!conflict||conflict.remoteVersion!==input.remoteVersion||
      conflict.localOperationId!==input.localOperationId)
      throw Error("Conflict changed; refresh and review the latest versions");
    if(input.entityType==="personal-task")
      this.tasks.resolvePersonalTaskConflict(ownerId,input);
    else{
      this.calendar.resolveManualCalendarConflict(ownerId,conflict,input);
      this.tasks.clearPersonalSyncConflict(ownerId,input);
    }
    return {resolved:true,choice:input.choice};
  }

  hasInFlightRun():boolean{return this.running!==null||this.replacementRunning!==null;}

  /** The preview is local-only and has no power to choose an owner or device. */
  reviewDeviceReplacement():PersonalSyncDeviceReplacementReview{
    if(this.stopping||this.hasInFlightRun())throw Error("Wait until personal sync is idle before replacing a device");
    this.replacementReview=null;
    const ownerId=this.cloud.currentUserId();
    const device=this.tasks.getOrCreatePersonalSyncDevice(ownerId);
    if(this.tasks.getPendingPersonalSyncPull(ownerId))return {
      eligible:false,reviewToken:null,
      reason:"上次拉取尚未完成本地恢复，请先点击“立即同步”完成恢复，再检查设备更换条件。",
    };
    const pending=this.tasks.countPersonalSyncOutbox(ownerId)+
      this.calendar.countManualCalendarSyncOutbox(ownerId);
    const conflicts=this.tasks.countPersonalSyncConflicts(ownerId);
    if(pending||conflicts)return {eligible:false,reviewToken:null,
      reason:"当前账号存在待发送修改或未解决的同步冲突，不能更换设备。请先处理这些内容。"};
    const token=randomUUID();
    this.replacementReview={ownerId,deviceId:device.deviceId,cursor:device.cursor,token};
    return {eligible:true,reviewToken:token,reason:null};
  }

  /** Revoke the old owner-scoped identity first; never reset cursor/queue. */
  replaceDevice(raw:unknown):Promise<{replaced:true}>{
    if(this.stopping||this.hasInFlightRun())return Promise.reject(Error("Personal sync is in progress"));
    const input=parsePersonalSyncDeviceReplacementRequest(raw);
    const review=this.replacementReview;
    this.replacementReview=null; // one-time token even if cloud fails
    if(!review||review.token!==input.reviewToken||this.cloud.currentUserId()!==review.ownerId)
      return Promise.reject(Error("Device replacement review expired or account changed"));
    const job=this.performDeviceReplacement(review).finally(()=>{
      if(this.replacementRunning===job)this.replacementRunning=null;
    });
    this.replacementRunning=job;
    return job;
  }

  private async performDeviceReplacement(review:{ownerId:string;deviceId:string;cursor:string}):
    Promise<{replaced:true}>{
    this.assertOwner(review.ownerId);
    const device=this.tasks.getOrCreatePersonalSyncDevice(review.ownerId);
    if(device.deviceId!==review.deviceId||device.cursor!==review.cursor)
      throw Error("Personal sync device changed; review replacement again");
    if(this.tasks.getPendingPersonalSyncPull(review.ownerId))
      throw Error("Interrupted personal sync pull must be recovered before device replacement");
    if(this.tasks.countPersonalSyncOutbox(review.ownerId)||
      this.calendar.countManualCalendarSyncOutbox(review.ownerId)||
      this.tasks.countPersonalSyncConflicts(review.ownerId))
      throw Error("Resolve pending local operations and conflicts before replacement");
    // false means the old ID is already revoked or not registered. Never
    // rotate if the RPC fails or authentication changes while it is in flight.
    await this.cloud.revokePersonalSyncDevice(review.deviceId);
    this.assertOwner(review.ownerId);
    if(this.calendar.countManualCalendarSyncOutbox(review.ownerId))
      throw Error("A calendar edit was queued during device replacement; review again");
    this.tasks.rotatePersonalSyncDevice(review.ownerId,review.deviceId,review.cursor);
    return {replaced:true};
  }

  cancel():void{this.stopping=true;this.replacementReview=null;}

  waitForIdle():Promise<void>{
    return Promise.allSettled([this.running,this.replacementRunning]).then(()=>undefined);
  }

  private assertOwner(ownerId:string):void{
    if(this.stopping)throw Error("Personal synchronization stopped");
    if(this.cloud.currentUserId()!==ownerId)
      throw Error("Cloud account changed during personal sync; no further local changes were applied");
  }

  private async performSync():Promise<PersonalSyncRunResult>{
    const ownerId=this.cloud.currentUserId();
    // Recover a page that was fully persisted before the previous process
    // stopped, *before any network push or new device registration*.
    let recoveredPages=0;
    const unfinished=this.tasks.getPendingPersonalSyncPull(ownerId);
    if(unfinished){
      this.applyStagedPull(ownerId,unfinished.deviceId,unfinished.fromCursor,unfinished.page);
      recoveredPages=1;
    }
    const device=this.tasks.getOrCreatePersonalSyncDevice(ownerId);
    await this.cloud.registerPersonalSyncDevice(device.deviceId,deviceLabel());
    this.assertOwner(ownerId);

    const taskOutbox=this.tasks.listPersonalSyncOutbox(ownerId,PUSH_LIMIT)
      .map(item=>({...item,entityType:"personal-task" as const}));
    const calendarOutbox=this.calendar.listManualCalendarSyncOutbox(ownerId,PUSH_LIMIT)
      .map(item=>({...item,entityType:"manual-calendar-event" as const}));
    const pending:PendingOutbox[]=[...taskOutbox,...calendarOutbox].sort((a,b)=>
      a.createdAt.localeCompare(b.createdAt)||a.operationId.localeCompare(b.operationId));
    // If an older nonzero cursor is ahead of the server (for example after
    // restoring mismatched SQLite backups), pushing first would publish data
    // before discovering the inconsistency. Validate the saved position using
    // an owner/device-authenticated read-only RPC before any pending upload.
    // If remote changes exist, pull them first in this run and defer every
    // outgoing operation until the user can review any new conflicts.
    // A run that has just replayed an interrupted cross-store page is
    // deliberately pull-only. Let the user inspect that recovery before
    // the next explicitly requested upload.
    let pushDeferred=recoveredPages>0&&pending.length>0;
    if(pending.length>0&&!pushDeferred){
      const preflight=await this.cloud.pullPersonalSyncChanges(device.deviceId,device.cursor,1);
      this.assertOwner(ownerId);
      if(preflight.changes.length===0&&preflight.nextCursor!==device.cursor)
        throw Error("Cloud preflight attempted to advance an empty cursor page");
      pushDeferred=preflight.changes.length>0;
    }
    let pushed=0,pushConflicts=0,rejected=0,retryableFailures=0;

    for(const item of (pushDeferred?[]:pending)){
      this.assertOwner(ownerId);
      // A prior network request may have allowed the user to edit or revoke this
      // later queue item. Never upload a stale snapshot that is no longer pending.
      const stillPending=item.entityType==="personal-task"
        ? this.tasks.hasPendingPersonalSyncOperation(ownerId,item.operationId)
        : this.calendar.hasPendingManualCalendarSyncOperation(ownerId,item.operationId);
      if(!stillPending)continue;
      // Never send an unresolved conflict just because its pending operation
      // still exists; only an explicit user resolution can rebase that intent.
      if(this.tasks.getPersonalSyncConflict(ownerId,item.entityType,item.entityId))continue;
      const createdAt=new Date(item.createdAt);
      if(!Number.isFinite(createdAt.getTime()))throw Error("Local sync queue contains an invalid timestamp");
      const payload=item.payload===null?null:JSON.parse(item.payload) as unknown;
      const operation=parsePersonalSyncOperation({
        operationId:item.operationId,deviceId:device.deviceId,actorId:ownerId,ownerId,
        entityId:item.entityId,entityType:item.entityType,action:item.action,
        baseVersion:item.baseVersion,clientTimestamp:createdAt.toISOString(),payload,
      });
      const result=await this.cloud.applyPersonalSyncOperation(operation);
      this.assertOwner(ownerId);
      if(result.status==="accepted"||result.status==="duplicate"){
        if(result.serverVersion===null)throw Error("Cloud acknowledgement omitted its server version");
        if(item.entityType==="personal-task"){
          const acknowledged=this.tasks.acknowledgePersonalSyncOperation(ownerId,item.operationId,item.entityId,
            item.action,result.serverVersion,item.baseVersion);
          if(acknowledged==="not-pending")
            this.tasks.rebasePersonalSyncOperation(ownerId,item.entityId,item.action,
              result.serverVersion,item.baseVersion);
        }else{
          const acknowledged=this.calendar.acknowledgeManualCalendarSyncOperation(ownerId,item.operationId,
            item.entityId,item.action,result.serverVersion,item.baseVersion);
          if(acknowledged==="not-pending")
            this.calendar.rebaseManualCalendarSyncOperation(ownerId,item.entityId,item.action,
              result.serverVersion,item.baseVersion);
        }
        pushed++;
      }else if(result.status==="conflict"){
        pushConflicts++;
      }else if(result.status==="rejected"){
        rejected++;
      }else{
        retryableFailures++;
        // A retryable server response is not an acknowledgement. Stop this push pass.
        break;
      }
    }

    let cursor=device.cursor,pulled=0,pullPages=0,hasMore=false;
    for(let pageNumber=0;pageNumber<MAX_PULL_PAGES_PER_RUN;pageNumber++){
      this.assertOwner(ownerId);
      const page=await this.cloud.pullPersonalSyncChanges(device.deviceId,cursor,PULL_PAGE_SIZE);
      this.assertOwner(ownerId);
      if(page.changes.length===0){
        if(page.nextCursor!==cursor)throw Error("Cloud attempted to advance a cursor without returning changes");
        hasMore=false;
        break;
      }
      if(BigInt(page.changes[0].cursor)<=BigInt(cursor)||
        BigInt(page.nextCursor)<=BigInt(cursor))
        throw Error("Cloud returned changes at or behind the saved cursor");

      // A conflict remains an explicit user decision even after its local
      // outbox entry is revoked. Later remote pages may update the reviewed
      // server version, but must never silently apply over the held local copy.
      this.applyStagedPull(ownerId,device.deviceId,cursor,page);
      cursor=page.nextCursor;
      pulled+=page.changes.length;
      pullPages++;
      hasMore=page.hasMore;
      if(!page.hasMore)break;
      if(pageNumber===MAX_PULL_PAGES_PER_RUN-1)hasMore=true;
    }

    const pendingTasks=this.tasks.countPersonalSyncOutbox(ownerId);
    const pendingCalendar=this.calendar.countManualCalendarSyncOutbox(ownerId);
    const conflicts=this.tasks.countPersonalSyncConflicts(ownerId);
    return {ownerId,deviceId:device.deviceId,pushed,pulled,pullPages,conflicts,pushConflicts,
      rejected,retryableFailures,pushDeferred,recoveredPages,pending:pendingTasks+pendingCalendar,cursor,hasMore};
  }

  /** Each page is written to task SQLite before touching either local store.
   * A partial crash leaves the same immutable page for bounded replay. */
  private applyStagedPull(ownerId:string,deviceId:string,fromCursor:string,
    page:PersonalSyncPullPage):void{
    this.assertOwner(ownerId);
    const existing=this.tasks.getPendingPersonalSyncPull(ownerId);
    if(!existing)this.tasks.beginPersonalSyncPullPage(ownerId,deviceId,fromCursor,page);
    else if(existing.deviceId!==deviceId||existing.fromCursor!==fromCursor||
      JSON.stringify(existing.page)!==JSON.stringify(page))
      throw Error("Interrupted sync checkpoint does not match this pull page");
    this.assertOwner(ownerId);
    const ready:PersonalSyncChange[]=[];
    const held:PersonalSyncConflict[]=[];
      for(const change of page.changes){
        const conflict=this.tasks.getPersonalSyncConflict(ownerId,change.entityType,change.entityId);
        if(!conflict){ready.push(change);continue;}
        if(change.version>conflict.remoteVersion){
          held.push({
            ...conflict,remoteVersion:change.version,remotePayload:change.payload,
            remoteDeleted:change.deleted,remoteUpdatedAt:change.updatedAt,
            reason:conflict.reason==="remote-change-while-local-pending"||
              conflict.reason==="remote-delete-while-local-pending"
              ? change.deleted?"remote-delete-while-local-pending":"remote-change-while-local-pending"
              : conflict.reason,
          });
        }
      }
      const taskChanges=ready.filter(change=>change.entityType==="personal-task");
      const calendarChanges=ready.filter(change=>change.entityType==="manual-calendar-event");
      const conflicts:PersonalSyncConflict[]=[
        ...held,
        ...this.tasks.applyRemotePersonalTaskChanges(ownerId,taskChanges),
        ...this.calendar.applyRemoteManualCalendarChanges(ownerId,calendarChanges),
      ];
      if(conflicts.length)this.tasks.recordPersonalSyncConflicts(ownerId,conflicts);
    this.assertOwner(ownerId);
    // The cursor advance and checkpoint deletion occur in one task-DB transaction.
    // If either local store or conflict recording failed, keep the checkpoint.
    this.tasks.finishPersonalSyncPullPage(ownerId,deviceId,fromCursor,page.nextCursor);
  }
}
