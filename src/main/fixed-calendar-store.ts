import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync,backup } from "node:sqlite";
import { LocalStore } from "./local-store";
import { requireUuid } from "../shared/cloud-model";
import type {
  PersonalSyncChange, PersonalSyncConflict, PersonalSyncCandidate, ManualCalendarSnapshot,
  PersonalSyncConflictRecord, PersonalSyncResolutionRequest,
} from "../shared/personal-sync-contract";
import { dayOffset } from "../shared/planning-model";
import { toLocalCanvasSlot,type CanvasCalendarEvent,type CanvasCalendarFixedEvent,
  type CanvasCalendarSyncResult } from "../shared/canvas-calendar-model";
import type { CalendarDisplayEvent } from "../shared/canvas-calendar-model";
import {
  parseCreateFixedEvent,parseEditFixedEvent,parseEditFixedSeries,
  validateFixedSlot,validateFixedTitle,weeklyOccurrences,timesOverlap,
  type BusySlot,type FixedEvent,type FixedEventDraft,type ICSImportResult,
} from "../shared/fixed-calendar-model";

interface EventRow {
  id:string;source_uid:string|null;series_id:string|null;title:string;day:string;
  start_minute:number;duration_minutes:number;source:"manual"|"ics";created_at:string;
}
function fromRow(row:EventRow):FixedEvent{
  return {id:row.id,sourceUid:row.source_uid,seriesId:row.series_id??null,title:row.title,day:row.day,
    startMinute:row.start_minute,durationMinutes:row.duration_minutes,
    source:row.source,createdAt:row.created_at};
}
const MAX_EVENTS=2000;
function syncOwnerId(input:unknown):string{return requireUuid(input).toLowerCase();}

/** Independent, local-only authority for fixed classes and imported calendar events. */
export class FixedCalendarStore {
  private readonly db:DatabaseSync;
  constructor(path:string,private readonly studyBlocks:()=>BusySlot[]=()=>[],
    private readonly activeCanvasScope:()=>{origin:string;accountId:number}|null=()=>null){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>5)throw Error("Calendar database is from a newer version");
    if(version===5)return;
    if(version===0)this.db.exec(
      "BEGIN IMMEDIATE;"+
      "CREATE TABLE fixed_events("+
      "id TEXT PRIMARY KEY, source_uid TEXT UNIQUE, title TEXT NOT NULL, day TEXT NOT NULL,"+
      "start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),"+
      "duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 15 AND 1440),"+
      "source TEXT NOT NULL CHECK(source IN('manual','ics')), created_at TEXT NOT NULL,"+
      "CHECK(start_minute+duration_minutes<=1440));"+
      "CREATE INDEX fixed_events_day ON fixed_events(day,start_minute);"+
      "PRAGMA user_version=1; COMMIT;"
    );
    if(version<=1)this.db.exec(
      "BEGIN IMMEDIATE; ALTER TABLE fixed_events ADD COLUMN series_id TEXT;"+
      "CREATE INDEX fixed_events_series ON fixed_events(series_id);"+
      "PRAGMA user_version=2; COMMIT;"
    );
    if(version<=2){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(
          "CREATE TABLE canvas_calendar_events("+
          "id TEXT PRIMARY KEY,instance_origin TEXT NOT NULL,account_id INTEGER NOT NULL,"+
          "course_id INTEGER NOT NULL,remote_id INTEGER NOT NULL,title TEXT NOT NULL,"+
          "day TEXT NOT NULL,start_minute INTEGER NOT NULL,duration_minutes INTEGER NOT NULL,"+
          "visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN(0,1)),"+
          "missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN(0,1)),"+
          "hidden_at TEXT,retention_expires_at TEXT,last_synced_at TEXT NOT NULL,"+
          "created_at TEXT NOT NULL,"+
          "UNIQUE(instance_origin,account_id,course_id,remote_id));"+
          "CREATE INDEX canvas_calendar_scope ON canvas_calendar_events(instance_origin,account_id,day);"+
          "PRAGMA user_version=3;"
        );
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(version<=3){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          CREATE TABLE manual_calendar_sync_enrollment(
            event_id TEXT PRIMARY KEY REFERENCES fixed_events(id) ON DELETE CASCADE,
            server_version INTEGER,
            enabled_at TEXT NOT NULL
          );
          CREATE TABLE manual_calendar_sync_outbox(
            operation_id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL UNIQUE,
            action TEXT NOT NULL CHECK(action IN('upsert','delete')),
            base_version INTEGER,
            payload TEXT,
            created_at TEXT NOT NULL,
            CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
          );
          CREATE INDEX manual_calendar_sync_outbox_created ON manual_calendar_sync_outbox(created_at);
          PRAGMA user_version=4;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(version<=4){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          ALTER TABLE manual_calendar_sync_enrollment RENAME TO manual_calendar_sync_legacy_enrollment;
          ALTER TABLE manual_calendar_sync_outbox RENAME TO manual_calendar_sync_legacy_outbox;
          ALTER TABLE manual_calendar_sync_legacy_enrollment ADD COLUMN claimed_by_owner_id TEXT;
          ALTER TABLE manual_calendar_sync_legacy_enrollment ADD COLUMN claimed_at TEXT;
          ALTER TABLE manual_calendar_sync_legacy_outbox ADD COLUMN claimed_by_owner_id TEXT;
          ALTER TABLE manual_calendar_sync_legacy_outbox ADD COLUMN claimed_at TEXT;
          CREATE TABLE manual_calendar_sync_enrollment(
            owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
            event_id TEXT NOT NULL REFERENCES fixed_events(id) ON DELETE CASCADE,
            server_version INTEGER CHECK(server_version IS NULL OR server_version>0),
            enabled_at TEXT NOT NULL,
            PRIMARY KEY(owner_id,event_id)
          );
          CREATE TABLE manual_calendar_sync_outbox(
            owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
            operation_id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN('upsert','delete')),
            base_version INTEGER CHECK(base_version IS NULL OR base_version>=0),
            payload TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(owner_id,entity_id),
            CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
          );
          CREATE INDEX manual_calendar_sync_outbox_owner_created
            ON manual_calendar_sync_outbox(owner_id,created_at,operation_id);
          CREATE INDEX manual_calendar_sync_enrollment_owner
            ON manual_calendar_sync_enrollment(owner_id,enabled_at);
          PRAGMA user_version=5;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
  }
  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}
  /** Enroll exactly one manually created event for one authenticated owner. */
  setManualEventSyncEnabled(id:string,enabled:boolean,ownerInput:unknown,now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput);
    if(typeof id!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(id)||typeof enabled!=="boolean")
      throw Error("Invalid calendar sync preference");
    const event=this.list().find(item=>item.id===id);
    if(!event||event.source!=="manual"||event.sourceUid!==null)
      throw Error("Only manually created calendar events can be enrolled");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(!enabled){
        this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?").run(ownerId,id);
        this.db.prepare("DELETE FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?").run(ownerId,id);
      }else{
        this.db.prepare("INSERT INTO manual_calendar_sync_enrollment(owner_id,event_id,server_version,enabled_at) VALUES(?,?,NULL,?) ON CONFLICT(owner_id,event_id) DO NOTHING")
          .run(ownerId,id,now.toISOString());
        this.enqueueManualEventForOwner(id,ownerId,now);
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  private enqueueManualEvent(id:string,now=new Date()):void{
    const enrollments=this.db.prepare(
      "SELECT owner_id FROM manual_calendar_sync_enrollment WHERE event_id=? ORDER BY owner_id"
    ).all(id) as {owner_id:string}[];
    for(const enrollment of enrollments)this.enqueueManualEventForOwner(id,enrollment.owner_id,now);
  }

  private enqueueManualEventForOwner(id:string,ownerId:string,now=new Date()):void{
    const event=this.list().find(item=>item.id===id);
    if(!event||event.source!=="manual"||event.sourceUid!==null)
      throw Error("Only manual events can be queued");
    const enrollment=this.db.prepare(
      "SELECT server_version FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?"
    ).get(ownerId,id) as {server_version:number|null}|undefined;
    if(!enrollment)return;
    const payload=JSON.stringify({title:event.title,day:event.day,startMinute:event.startMinute,
      durationMinutes:event.durationMinutes,seriesId:event.seriesId});
    this.db.prepare(`
      INSERT INTO manual_calendar_sync_outbox(owner_id,operation_id,entity_id,action,base_version,payload,created_at)
      VALUES(?,?,?,'upsert',?,?,?)
      ON CONFLICT(owner_id,entity_id) DO UPDATE SET
        operation_id=excluded.operation_id,action='upsert',base_version=excluded.base_version,
        payload=excluded.payload,created_at=excluded.created_at
    `).run(ownerId,randomUUID(),id,enrollment.server_version,payload,now.toISOString());
  }

  listManualCalendarSyncCandidates(ownerInput:unknown,limit=500):PersonalSyncCandidate[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("Invalid sync candidate limit");
    const rows=this.db.prepare(`
      SELECT f.id,f.title,f.day,f.start_minute,f.duration_minutes,e.server_version,e.event_id AS enrolled
      FROM fixed_events f
      LEFT JOIN manual_calendar_sync_enrollment e ON e.owner_id=? AND e.event_id=f.id
      WHERE f.source='manual' AND f.source_uid IS NULL
      ORDER BY f.day,f.start_minute,f.id LIMIT ?
    `).all(ownerId,limit) as unknown as {
      id:string;title:string;day:string;start_minute:number;duration_minutes:number;
      server_version:number|null;enrolled:string|null;
    }[];
    return rows.map(row=>({entityType:"manual-calendar-event",entityId:row.id,title:row.title,
      detail:row.day+" · "+String(Math.floor(row.start_minute/60)).padStart(2,"0")+":"+
        String(row.start_minute%60).padStart(2,"0")+" · "+row.duration_minutes+" 分钟",
      enabled:row.enrolled!==null,serverVersion:row.server_version}));
  }

  listManualCalendarSyncOutbox(ownerInput:unknown,limit=100):{
    operationId:string;entityId:string;action:"upsert"|"delete";baseVersion:number|null;
    payload:string|null;createdAt:string;
  }[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("Invalid outbox limit");
    return (this.db.prepare(
      "SELECT operation_id,entity_id,action,base_version,payload,created_at "+
      "FROM manual_calendar_sync_outbox WHERE owner_id=? ORDER BY created_at,operation_id LIMIT ?"
    ).all(ownerId,limit) as unknown as {operation_id:string;entity_id:string;action:"upsert"|"delete";
      base_version:number|null;payload:string|null;created_at:string}[])
      .map(row=>({operationId:row.operation_id,entityId:row.entity_id,action:row.action,
        baseVersion:row.base_version,payload:row.payload,createdAt:row.created_at}));
  }

  hasPendingManualCalendarSyncOperation(ownerInput:unknown,operationIdInput:unknown):boolean{
    const ownerId=syncOwnerId(ownerInput),operationId=requireUuid(operationIdInput);
    return Boolean(this.db.prepare(
      "SELECT 1 AS found FROM manual_calendar_sync_outbox WHERE owner_id=? AND operation_id=?"
    ).get(ownerId,operationId));
  }

  countManualCalendarSyncOutbox(ownerInput:unknown):number{
    const ownerId=syncOwnerId(ownerInput);
    const row=this.db.prepare(
      "SELECT COUNT(*) AS count FROM manual_calendar_sync_outbox WHERE owner_id=?"
    ).get(ownerId) as {count:number};
    return row.count;
  }

  listManualCalendarSyncEnrollments(ownerInput:unknown):{
    eventId:string;title:string;serverVersion:number|null;enabledAt:string;
  }[]{
    const ownerId=syncOwnerId(ownerInput);
    return (this.db.prepare(`
      SELECT e.event_id,f.title,e.server_version,e.enabled_at
      FROM manual_calendar_sync_enrollment e JOIN fixed_events f ON f.id=e.event_id
      WHERE e.owner_id=? ORDER BY e.enabled_at,e.event_id
    `).all(ownerId) as unknown as {event_id:string;title:string;server_version:number|null;enabled_at:string}[])
      .map(row=>({eventId:row.event_id,title:row.title,serverVersion:row.server_version,enabledAt:row.enabled_at}));
  }

  listLegacyManualCalendarSyncItems(limit=100):{
    operationId:string|null;entityId:string;action:"upsert"|"delete"|"enrolled";
    title:string|null;createdAt:string;canReauthorize:boolean;
  }[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("Invalid legacy sync item limit");
    const rows=this.db.prepare(`
      SELECT o.operation_id,o.entity_id,o.action,f.title,o.created_at,
        CASE WHEN o.action='upsert' AND f.id IS NOT NULL AND f.source='manual' AND f.source_uid IS NULL
          THEN 1 ELSE 0 END AS can_reauthorize
      FROM manual_calendar_sync_legacy_outbox o LEFT JOIN fixed_events f ON f.id=o.entity_id
      WHERE o.claimed_by_owner_id IS NULL
      UNION ALL
      SELECT NULL AS operation_id,e.event_id AS entity_id,'enrolled' AS action,f.title,e.enabled_at AS created_at,
        CASE WHEN f.id IS NOT NULL AND f.source='manual' AND f.source_uid IS NULL THEN 1 ELSE 0 END AS can_reauthorize
      FROM manual_calendar_sync_legacy_enrollment e LEFT JOIN fixed_events f ON f.id=e.event_id
      WHERE e.claimed_by_owner_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM manual_calendar_sync_legacy_outbox o WHERE o.entity_id=e.event_id)
      ORDER BY created_at,entity_id LIMIT ?
    `).all(limit) as unknown as {operation_id:string|null;entity_id:string;action:"upsert"|"delete"|"enrolled";
      title:string|null;created_at:string;can_reauthorize:number}[];
    return rows.map(row=>({operationId:row.operation_id,entityId:row.entity_id,action:row.action,
      title:row.title,createdAt:row.created_at,canReauthorize:row.can_reauthorize===1}));
  }

  /** Re-authorize one surviving legacy manual event; old versions are never trusted across accounts. */
  adoptLegacyManualEventSync(ownerInput:unknown,eventInput:unknown,confirmation:unknown,now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput);
    if(confirmation!==true)throw Error("Explicit confirmation is required to re-authorize a legacy event");
    if(typeof eventInput!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(eventInput))
      throw Error("Invalid calendar event identifier");
    const eventId=eventInput;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const event=this.list().find(item=>item.id===eventId);
      if(!event||event.source!=="manual"||event.sourceUid!==null)
        throw Error("Only an existing manual event can be re-authorized");
      const legacyEnrollment=this.db.prepare(
        "SELECT 1 AS found FROM manual_calendar_sync_legacy_enrollment WHERE event_id=? AND claimed_by_owner_id IS NULL"
      ).get(eventId);
      const legacyOutbox=this.db.prepare(
        "SELECT action FROM manual_calendar_sync_legacy_outbox WHERE entity_id=? AND claimed_by_owner_id IS NULL"
      ).get(eventId) as {action:string}|undefined;
      if(!legacyEnrollment&&!legacyOutbox)throw Error("No unclaimed legacy sync preference exists for this event");
      if(legacyOutbox?.action==="delete")
        throw Error("Legacy delete tombstones remain quarantined for manual review");
      const existing=this.db.prepare(
        "SELECT 1 AS found FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?"
      ).get(ownerId,eventId);
      if(existing)throw Error("This event is already enrolled for this account");
      this.db.prepare(
        "INSERT INTO manual_calendar_sync_enrollment(owner_id,event_id,server_version,enabled_at) VALUES(?,?,NULL,?)"
      ).run(ownerId,eventId,now.toISOString());
      this.enqueueManualEventForOwner(eventId,ownerId,now);
      this.db.prepare(
        "UPDATE manual_calendar_sync_legacy_enrollment SET claimed_by_owner_id=?,claimed_at=? "+
        "WHERE event_id=? AND claimed_by_owner_id IS NULL"
      ).run(ownerId,now.toISOString(),eventId);
      this.db.prepare(
        "UPDATE manual_calendar_sync_legacy_outbox SET claimed_by_owner_id=?,claimed_at=? "+
        "WHERE entity_id=? AND action='upsert' AND claimed_by_owner_id IS NULL"
      ).run(ownerId,now.toISOString(),eventId);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  acknowledgeManualCalendarSyncOperation(ownerInput:unknown,operationId:string,entityIdInput:unknown,
    actionInput:unknown,serverVersion:number,expectedBaseVersion:number|null):
    "acknowledged"|"not-pending"{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(entityIdInput);
    requireUuid(operationId);
    if((actionInput!=="upsert"&&actionInput!=="delete")||
      !Number.isSafeInteger(serverVersion)||serverVersion<1||
      (expectedBaseVersion!==null&&(!Number.isSafeInteger(expectedBaseVersion)||expectedBaseVersion<0)))
      throw Error("Invalid sync acknowledgement");
    const action=actionInput as "upsert"|"delete";
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const row=this.db.prepare(
        "SELECT entity_id,action,base_version FROM manual_calendar_sync_outbox WHERE owner_id=? AND operation_id=?"
      ).get(ownerId,operationId) as {entity_id:string;action:string;base_version:number|null}|undefined;
      if(!row){
        this.db.exec("COMMIT");
        return "not-pending";
      }
      if(row.entity_id!==entityId||row.action!==action||row.base_version!==expectedBaseVersion)
        throw Error("Sync acknowledgement does not match its pending operation");
      this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND operation_id=?")
        .run(ownerId,operationId);
      if(action==="upsert")
        this.db.prepare("UPDATE manual_calendar_sync_enrollment SET server_version=? WHERE owner_id=? AND event_id=?")
          .run(serverVersion,ownerId,entityId);
      if(action==="delete")
        this.db.prepare("DELETE FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?")
          .run(ownerId,entityId);
      this.db.exec("COMMIT");
      return "acknowledged";
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  rebaseManualCalendarSyncOperation(ownerInput:unknown,entityIdInput:unknown,actionInput:unknown,
    serverVersion:number,expectedBaseVersion:number|null):
    "superseded"|"deleted-during-upload"|"stale"{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(entityIdInput);
    if((actionInput!=="upsert"&&actionInput!=="delete")||
      !Number.isSafeInteger(serverVersion)||serverVersion<1||
      (expectedBaseVersion!==null&&(!Number.isSafeInteger(expectedBaseVersion)||expectedBaseVersion<0)))
      throw Error("Invalid sync rebase");
    const action=actionInput as "upsert"|"delete";
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const newer=this.db.prepare(
        "SELECT operation_id,base_version FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?"
      ).get(ownerId,entityId) as {operation_id:string;base_version:number|null}|undefined;
      if(newer&&newer.base_version===expectedBaseVersion){
        this.db.prepare(
          "UPDATE manual_calendar_sync_enrollment SET server_version=? WHERE owner_id=? AND event_id=?"
        ).run(serverVersion,ownerId,entityId);
        this.db.prepare(
          "UPDATE manual_calendar_sync_outbox SET base_version=? WHERE owner_id=? AND operation_id=?"
        ).run(serverVersion,ownerId,newer.operation_id);
        this.db.exec("COMMIT");
        return "superseded";
      }
      const eventExists=this.db.prepare(
        "SELECT 1 AS found FROM fixed_events WHERE id=? AND source='manual' AND source_uid IS NULL"
      ).get(entityId);
      if(!newer&&!eventExists&&action==="upsert"){
        this.db.prepare(`
          INSERT INTO manual_calendar_sync_outbox(owner_id,operation_id,entity_id,action,base_version,payload,created_at)
          VALUES(?,?,?,'delete',?,NULL,?)
          ON CONFLICT(owner_id,entity_id) DO UPDATE SET operation_id=excluded.operation_id,
            action='delete',base_version=excluded.base_version,payload=NULL,created_at=excluded.created_at
        `).run(ownerId,randomUUID(),entityId,serverVersion,new Date().toISOString());
        this.db.exec("COMMIT");
        return "deleted-during-upload";
      }
      this.db.exec("COMMIT");
      return "stale";
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }


  /** Apply one explicitly reviewed calendar conflict in a single calendar SQLite
   * transaction. Main must delete the separate task-DB conflict AFTER this commits. */
  resolveManualCalendarConflict(ownerInput:unknown,conflict:PersonalSyncConflictRecord,
    input:PersonalSyncResolutionRequest,now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(input.entityId);
    if(input.entityType!=="manual-calendar-event"||conflict.entityId!==entityId||
      conflict.entityType!=="manual-calendar-event"||
      conflict.remoteVersion!==input.remoteVersion||
      conflict.localOperationId!==input.localOperationId||
      (conflict.reason!=="remote-change-while-local-pending"&&
        conflict.reason!=="remote-delete-while-local-pending"))
      throw Error("Conflict changed; refresh and review the latest versions");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const pending=this.db.prepare(
        "SELECT operation_id,action,payload FROM manual_calendar_sync_outbox "+
        "WHERE owner_id=? AND entity_id=?"
      ).get(ownerId,entityId) as {
        operation_id:string;action:"upsert"|"delete";payload:string|null;
      }|undefined;
      const event=this.list().find(item=>item.id===entityId);
      const snapshot=event?JSON.stringify({
        title:event.title,day:event.day,startMinute:event.startMinute,
        durationMinutes:event.durationMinutes,seriesId:event.seriesId,
      }):null;
      if(!pending||pending.operation_id!==input.localOperationId||
        pending.action!==conflict.localAction||
        JSON.stringify(pending.payload?JSON.parse(pending.payload):null)!==
          JSON.stringify(conflict.localPayload)||
        (pending.action==="upsert"&&
          (!event||event.source!=="manual"||event.sourceUid!==null||snapshot!==pending.payload))||
        (pending.action==="delete"&&event))
        throw Error("Local calendar event changed; refresh and review before resolving");
      if(input.choice==="use-remote"){
        const otherEnrollment=this.db.prepare(
          "SELECT 1 FROM manual_calendar_sync_enrollment WHERE event_id=? AND owner_id<>? LIMIT 1"
        ).get(entityId,ownerId);
        const otherPending=this.db.prepare(
          "SELECT 1 FROM manual_calendar_sync_outbox WHERE entity_id=? AND owner_id<>? LIMIT 1"
        ).get(entityId,ownerId);
        if(otherEnrollment||otherPending)
          throw Error("This event is also linked to another account; remote overwrite is blocked");
        if(conflict.remoteDeleted){
          this.db.prepare(
            "DELETE FROM fixed_events WHERE id=? AND source='manual' AND source_uid IS NULL"
          ).run(entityId);
          this.db.prepare(
            "DELETE FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?"
          ).run(ownerId,entityId);
        }else{
          const remote=conflict.remotePayload as ManualCalendarSnapshot|null;
          if(!remote)throw Error("Invalid remote calendar snapshot");
          const title=validateFixedTitle(remote.title);
          const slot=validateFixedSlot(remote.day,remote.startMinute,remote.durationMinutes);
          const seriesId=remote.seriesId;
          if(seriesId!==null){
            if(typeof seriesId!=="string"||!seriesId.startsWith("manual:"))
              throw Error("Only manual calendar series may sync");
            requireUuid(seriesId.slice("manual:".length));
          }
          this.guardStudyConflicts([slot]);
          if(event){
            this.db.prepare(`UPDATE fixed_events
              SET series_id=?,title=?,day=?,start_minute=?,duration_minutes=?
              WHERE id=? AND source='manual' AND source_uid IS NULL`)
              .run(seriesId,title,slot.day,slot.startMinute,slot.durationMinutes,entityId);
          }else{
            this.guardCount(1);
            this.db.prepare(`INSERT INTO fixed_events
              (id,source_uid,series_id,title,day,start_minute,duration_minutes,source,created_at)
              VALUES(?,NULL,?,?,?,?,?,'manual',?)`)
              .run(entityId,seriesId,title,slot.day,slot.startMinute,slot.durationMinutes,
                conflict.remoteUpdatedAt);
          }
          this.db.prepare(`INSERT INTO manual_calendar_sync_enrollment
            (owner_id,event_id,server_version,enabled_at) VALUES(?,?,?,?)
            ON CONFLICT(owner_id,event_id) DO UPDATE SET server_version=excluded.server_version`)
            .run(ownerId,entityId,conflict.remoteVersion,now.toISOString());
        }
        this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?")
          .run(ownerId,entityId);
      }else if(input.choice==="keep-local"){
        if(pending.action==="delete"&&conflict.remoteDeleted){
          this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?")
            .run(ownerId,entityId);
        }else{
          this.db.prepare(`UPDATE manual_calendar_sync_outbox
            SET operation_id=?,base_version=?,created_at=?
            WHERE owner_id=? AND entity_id=?`)
            .run(randomUUID(),conflict.remoteVersion,now.toISOString(),ownerId,entityId);
          if(event)this.db.prepare(`UPDATE manual_calendar_sync_enrollment
            SET server_version=? WHERE owner_id=? AND event_id=?`)
            .run(conflict.remoteVersion,ownerId,entityId);
        }
      }else throw Error("Invalid conflict resolution choice");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  applyRemoteManualCalendarChanges(ownerInput:unknown,changes:readonly PersonalSyncChange[],
    now=new Date()):PersonalSyncConflict[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Array.isArray(changes)||changes.length>500)throw Error("Invalid remote calendar changes");
    const conflicts:PersonalSyncConflict[]=[];
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const change of changes){
        if(change.entityType!=="manual-calendar-event"||!Number.isSafeInteger(change.version)||change.version<1)
          throw Error("Invalid remote manual calendar change");
        const entityId=requireUuid(change.entityId);
        const pending=this.db.prepare(
          "SELECT operation_id,action,base_version,payload FROM manual_calendar_sync_outbox "+
          "WHERE owner_id=? AND entity_id=?"
        ).get(ownerId,entityId) as {operation_id:string;action:"upsert"|"delete";
          base_version:number|null;payload:string|null}|undefined;
        if(pending){
          if(change.version>(pending.base_version??0)){
            conflicts.push({entityType:"manual-calendar-event",entityId,localOperationId:pending.operation_id,
              localAction:pending.action,localPayload:pending.payload?JSON.parse(pending.payload):null,
              remoteVersion:change.version,remotePayload:change.payload as PersonalSyncConflict["remotePayload"],
              remoteDeleted:change.deleted,remoteUpdatedAt:change.updatedAt,
              reason:change.deleted?"remote-delete-while-local-pending":"remote-change-while-local-pending"});
          }
          continue;
        }
        const enrollment=this.db.prepare(
          "SELECT server_version FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?"
        ).get(ownerId,entityId) as {server_version:number|null}|undefined;
        if(enrollment?.server_version!==null&&enrollment?.server_version!==undefined&&
          change.version<=enrollment.server_version)continue;
        const event=this.list().find(item=>item.id===entityId);
        if(event&&(!enrollment||event.source!=="manual"||event.sourceUid!==null)){
          const localPayload=event.source==="manual"&&event.sourceUid===null?{
            title:event.title,day:event.day,startMinute:event.startMinute,
            durationMinutes:event.durationMinutes,seriesId:event.seriesId,
          }:null;
          conflicts.push({entityType:"manual-calendar-event",entityId,localOperationId:null,localAction:null,
            localPayload,remoteVersion:change.version,
            remotePayload:change.payload as PersonalSyncConflict["remotePayload"],
            remoteDeleted:change.deleted,remoteUpdatedAt:change.updatedAt,
            reason:"local-entity-not-eligible"});
          continue;
        }
        if(change.deleted){
          this.db.prepare("DELETE FROM fixed_events WHERE id=? AND source='manual' AND source_uid IS NULL")
            .run(entityId);
          this.db.prepare("DELETE FROM manual_calendar_sync_enrollment WHERE owner_id=? AND event_id=?")
            .run(ownerId,entityId);
          continue;
        }
        const payload=change.payload as ManualCalendarSnapshot|null;
        if(!payload||typeof payload!=="object"||!("title" in payload))
          throw Error("Remote calendar snapshot is missing");
        const title=validateFixedTitle(payload.title);
        const slot=validateFixedSlot(payload.day,payload.startMinute,payload.durationMinutes);
        const seriesId=payload.seriesId;
        if(seriesId!==null){
          if(typeof seriesId!=="string"||!seriesId.startsWith("manual:"))
            throw Error("Only manual calendar series may sync");
          requireUuid(seriesId.slice("manual:".length));
        }
        if(!event){
          try{this.guardCount(1);}
          catch(error){
            if(!(error instanceof Error)||error.message!=="Calendar event capacity reached (2000)")throw error;
            conflicts.push({entityType:"manual-calendar-event",entityId,localOperationId:null,
              localAction:null,localPayload:null,remoteVersion:change.version,
              remotePayload:payload as PersonalSyncConflict["remotePayload"],remoteDeleted:false,
              remoteUpdatedAt:change.updatedAt,reason:"local-calendar-capacity"});
            continue;
          }
        }
        try{this.guardStudyConflicts([slot]);}
        catch{
          conflicts.push({entityType:"manual-calendar-event",entityId,localOperationId:null,
            localAction:null,localPayload:null,remoteVersion:change.version,
            remotePayload:payload as PersonalSyncConflict["remotePayload"],remoteDeleted:false,
            remoteUpdatedAt:change.updatedAt,reason:"remote-overlaps-study-plan"});
          continue;
        }
        if(event){
          this.db.prepare(`
            UPDATE fixed_events SET series_id=?,title=?,day=?,start_minute=?,duration_minutes=?
            WHERE id=? AND source='manual' AND source_uid IS NULL
          `).run(seriesId,title,slot.day,slot.startMinute,slot.durationMinutes,entityId);
        }else{
          this.db.prepare(`
            INSERT INTO fixed_events(id,source_uid,series_id,title,day,start_minute,duration_minutes,source,created_at)
            VALUES(?,NULL,?,?,?,?,?,'manual',?)
          `).run(entityId,seriesId,title,slot.day,slot.startMinute,slot.durationMinutes,change.updatedAt);
        }
        this.db.prepare(`
          INSERT INTO manual_calendar_sync_enrollment(owner_id,event_id,server_version,enabled_at)
          VALUES(?,?,?,?)
          ON CONFLICT(owner_id,event_id) DO UPDATE SET server_version=excluded.server_version
        `).run(ownerId,entityId,change.version,now.toISOString());
      }
      this.db.exec("COMMIT");
      return conflicts;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }


  list():FixedEvent[]{
    return (this.db.prepare("SELECT * FROM fixed_events ORDER BY day,start_minute,id")
      .all() as unknown as EventRow[]).map(fromRow);
  }
  busySlots():BusySlot[]{
    const local=this.list();
    const scope=this.activeCanvasScope();
    const canvas=scope?this.listCanvasEvents(scope.origin,scope.accountId)
      .filter(x=>x.visible&&!x.missing):[];
    return [...local,...canvas].map(({day,startMinute,durationMinutes})=>
      ({day,startMinute,durationMinutes}));
  }

  /** Never display another Canvas account's cached calendar data. */
  listCanvasEvents(origin:string,accountId:number):CanvasCalendarFixedEvent[]{
    if(typeof origin!=="string"||!origin.startsWith("https://")||
      !Number.isSafeInteger(accountId)||accountId<=0)throw Error("Invalid Canvas calendar scope");
    type Row={id:string;instance_origin:string;account_id:number;course_id:number;
      remote_id:number;title:string;day:string;start_minute:number;duration_minutes:number;
      visible:number;missing:number;retention_expires_at:string|null;
      last_synced_at:string;created_at:string};
    return (this.db.prepare(
      "SELECT * FROM canvas_calendar_events WHERE instance_origin=? AND account_id=? "+
      "ORDER BY day,start_minute,id").all(origin,accountId) as unknown as Row[]).map(row=>({
      id:row.id,sourceUid:null,seriesId:null,title:row.title,day:row.day,
      startMinute:row.start_minute,durationMinutes:row.duration_minutes,
      source:"canvas" as const,createdAt:row.created_at,visible:row.visible===1,
      missing:row.missing===1,instanceOrigin:row.instance_origin,accountId:row.account_id,
      courseId:row.course_id,remoteId:row.remote_id,
      lastSyncedAt:row.last_synced_at,retentionExpiresAt:row.retention_expires_at,
    }));
  }
  listForDisplay():CalendarDisplayEvent[]{
    const scope=this.activeCanvasScope();
    return [...this.list(),...(scope?this.listCanvasEvents(scope.origin,scope.accountId):[])];
  }
  setCanvasEventVisibility(id:unknown,visible:unknown,now=new Date()):boolean{
    if(typeof id!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(id)||
      typeof visible!=="boolean")throw Error("Invalid Canvas event visibility");
    const scope=this.activeCanvasScope();
    if(!scope)throw Error("Connect and verify Canvas before changing calendar visibility");
    const found=this.db.prepare(
      "SELECT visible FROM canvas_calendar_events WHERE id=? AND instance_origin=? AND account_id=?"
    ).get(id,scope.origin,scope.accountId) as {visible:number}|undefined;
    if(!found)throw Error("Canvas calendar event is not in the active account");
    if((found.visible===1)===visible)return true;
    return Number(this.db.prepare(
      "UPDATE canvas_calendar_events SET visible=?,hidden_at=?,retention_expires_at=? "+
      "WHERE id=? AND instance_origin=? AND account_id=?"
    ).run(visible?1:0,visible?null:now.toISOString(),
      visible?null:LocalStore.retentionExpiry(now),id,scope.origin,scope.accountId).changes)===1;
  }
  purgeExpiredHiddenCanvasEvents(now=new Date()):number{
    return Number(this.db.prepare(
      "DELETE FROM canvas_calendar_events WHERE visible=0 "+
      "AND retention_expires_at IS NOT NULL AND retention_expires_at<=?"
    ).run(now.toISOString()).changes);
  }
  /** Course-scoped, transactional, and opt-in visibility preserving. Never overwrites a hidden row. */
  reconcileCanvasCourse(origin:string,accountId:number,courseId:number,
    remote:CanvasCalendarEvent[],now=new Date(),
    window?:{startDate:string;endDate:string}):CanvasCalendarSyncResult{
    if(typeof origin!=="string"||!/^https:\/\/[^/]+$/.test(origin)||
      !Number.isSafeInteger(accountId)||accountId<=0||
      !Number.isSafeInteger(courseId)||courseId<=0||remote.length>1000||
      new Set(remote.map(x=>x.id)).size!==remote.length||
      remote.some(x=>x.courseId!==courseId||!Number.isSafeInteger(x.id)||x.id<=0))
      throw Error("Invalid Canvas calendar reconciliation");
    if(window && (!/^\d{4}-\d{2}-\d{2}$/.test(window.startDate)||
      !/^\d{4}-\d{2}-\d{2}$/.test(window.endDate)||window.startDate>window.endDate))
      throw Error("Invalid Canvas calendar reconciliation window");
    const result:CanvasCalendarSyncResult={created:0,changed:0,missing:0,skipped:0};
    const stamp=now.toISOString();
    const ids=new Set(remote.map(x=>x.id));
    const previous=this.db.prepare(
      "SELECT remote_id,missing,day FROM canvas_calendar_events "+
      "WHERE instance_origin=? AND account_id=? AND course_id=?"
    ).all(origin,accountId,courseId) as unknown as Array<{remote_id:number;missing:number;day:string}>;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const item of remote){
        const slot=toLocalCanvasSlot(item);
        if(!slot){result.skipped++;continue;}
        const existing=this.db.prepare(
          "SELECT id,title,day,start_minute,duration_minutes,visible,missing "+
          "FROM canvas_calendar_events WHERE instance_origin=? AND account_id=? "+
          "AND course_id=? AND remote_id=?"
        ).get(origin,accountId,courseId,item.id) as
          {id:string;title:string;day:string;start_minute:number;
           duration_minutes:number;visible:number;missing:number}|undefined;
        if(existing){
          const changed=existing.visible===1&&(existing.title!==item.title||
            existing.day!==slot.day||existing.start_minute!==slot.startMinute||
            existing.duration_minutes!==slot.durationMinutes||existing.missing===1);
          this.db.prepare(
            "UPDATE canvas_calendar_events SET title=?,day=?,start_minute=?,duration_minutes=?,"+
            "missing=0,last_synced_at=? WHERE id=?"
          ).run(existing.visible===1?item.title:existing.title,
            existing.visible===1?slot.day:existing.day,
            existing.visible===1?slot.startMinute:existing.start_minute,
            existing.visible===1?slot.durationMinutes:existing.duration_minutes,
            stamp,existing.id);
          if(changed)result.changed++;
        }else{
          const total=this.db.prepare("SELECT count(*) AS n FROM canvas_calendar_events")
            .get() as {n:number};
          if(total.n>=2000)throw Error("Canvas calendar cache limit reached");
          this.db.prepare(
            "INSERT INTO canvas_calendar_events("+
            "id,instance_origin,account_id,course_id,remote_id,title,day,"+
            "start_minute,duration_minutes,last_synced_at,created_at) "+
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)"
          ).run(randomUUID(),origin,accountId,courseId,item.id,item.title,slot.day,
            slot.startMinute,slot.durationMinutes,stamp,stamp);
          result.created++;
        }
      }
      for(const prev of previous){
        if(!ids.has(prev.remote_id)&&prev.missing===0 &&
          (!window||(prev.day>=window.startDate&&prev.day<=window.endDate))){
          this.db.prepare("UPDATE canvas_calendar_events SET missing=1 "+
            "WHERE instance_origin=? AND account_id=? AND course_id=? AND remote_id=?"
          ).run(origin,accountId,courseId,prev.remote_id);
          result.missing++;
        }
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return result;
  }

  private guardCount(extra:number):void{
    const existing=this.db.prepare("SELECT COUNT(*) AS count FROM fixed_events").get() as {count:number};
    if(existing.count+extra>MAX_EVENTS)throw Error("Calendar event capacity reached (2000)");
  }
  private guardStudyConflicts(candidates:ReadonlyArray<BusySlot>):void{
    const committed=this.studyBlocks();
    if(candidates.some(event=>committed.some(block=>timesOverlap(event,block))))
      throw Error("Fixed class overlaps an already confirmed study block; undo that plan first");
  }
  create(raw:unknown,now=new Date()):FixedEvent[]{
    const parsed=parseCreateFixedEvent(raw);
    const candidates=weeklyOccurrences(parsed);
    this.guardCount(candidates.length);
    this.guardStudyConflicts(candidates);
    const created:FixedEvent[]=[];
    const seriesId=parsed.weeks>1?"manual:"+randomUUID():null;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const put=this.db.prepare(
        "INSERT INTO fixed_events(id,source_uid,series_id,title,day,start_minute,duration_minutes,source,created_at)"+
        " VALUES(?,NULL,?,?,?,?,?,'manual',?)");
      for(const candidate of candidates){
        const id=randomUUID(),stamp=now.toISOString();
        put.run(id,seriesId,candidate.title,candidate.day,candidate.startMinute,candidate.durationMinutes,stamp);
        created.push({id,seriesId,...candidate,source:"manual",createdAt:stamp});
      }
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
    return created;
  }
  delete(input:unknown):boolean{
    if(typeof input!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(input))
      throw Error("Invalid calendar event identifier");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const enrollments=this.db.prepare(
        "SELECT owner_id,server_version FROM manual_calendar_sync_enrollment WHERE event_id=? ORDER BY owner_id"
      ).all(input) as {owner_id:string;server_version:number|null}[];
      const stamp=new Date().toISOString();
      for(const enrolled of enrollments){
        if(enrolled.server_version!==null){
          this.db.prepare(`
            INSERT INTO manual_calendar_sync_outbox(owner_id,operation_id,entity_id,action,base_version,payload,created_at)
            VALUES(?,?,?,'delete',?,NULL,?)
            ON CONFLICT(owner_id,entity_id) DO UPDATE SET operation_id=excluded.operation_id,
              action='delete',base_version=excluded.base_version,payload=NULL,created_at=excluded.created_at
          `).run(enrolled.owner_id,randomUUID(),input,enrolled.server_version,stamp);
        }else{
          this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?")
            .run(enrolled.owner_id,input);
        }
      }
      const removed=Number(this.db.prepare("DELETE FROM fixed_events WHERE id=?").run(input).changes)===1;
      this.db.exec("COMMIT");
      return removed;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /** A single occurrence may be edited, without mutating its parent series. */
  edit(raw:unknown):FixedEvent{
    const input=parseEditFixedEvent(raw);
    this.guardStudyConflicts([input]);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const existing=this.db.prepare("SELECT source FROM fixed_events WHERE id=?")
        .get(input.id) as {source:"manual"|"ics"}|undefined;
      if(!existing)throw Error("Calendar event no longer exists");
      const updated=this.db.prepare(
        "UPDATE fixed_events SET title=?,day=?,start_minute=?,duration_minutes=? WHERE id=?"
      ).run(input.title,input.day,input.startMinute,input.durationMinutes,input.id);
      if(Number(updated.changes)!==1)throw Error("Calendar event no longer exists");
      if(existing.source==="manual")this.enqueueManualEvent(input.id);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    const found=this.list().find(item=>item.id===input.id);
    if(!found)throw Error("Calendar event no longer exists");
    return found;
  }
  /** Transactionally update a manually created recurring course.
   * The chosen occurrence is the anchor except in custom-range mode, where
   * the first selected member is the date anchor. Each selected member shifts
   * by the same number of civil days, preserving relative spacing.
   * Existing unrelated events are never changed. Imported/Canvas sources are
   * intentionally excluded, even if they contain a series_id.
   */
  editSeries(raw:unknown):FixedEvent[] {
    const input=parseEditFixedSeries(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const anchor=this.db.prepare("SELECT * FROM fixed_events WHERE id=?")
        .get(input.id) as unknown as EventRow|undefined;
      if(!anchor||anchor.source!=="manual"||!anchor.series_id?.startsWith("manual:"))
        throw Error("Only manually created recurring courses can be edited as a series");
      const group=this.db.prepare("SELECT * FROM fixed_events WHERE series_id=? ORDER BY day,start_minute,id")
        .all(anchor.series_id) as unknown as EventRow[];
      const index=group.findIndex(row=>row.id===anchor.id);
      if(index<0||group.length<2||group.length>16)
        throw Error("Recurring course group cannot be edited");
      let selected:EventRow[];
      let dateAnchor=anchor;
      if(input.scope==="range"){
        const start=group.findIndex(row=>row.id===input.rangeStartId);
        const end=group.findIndex(row=>row.id===input.rangeEndId);
        if(start<0||end<0||start>end)
          throw Error("Invalid recurring course range: endpoints must belong to one series in date order");
        selected=group.slice(start,end+1);
        dateAnchor=group[start];
      }else{
        selected=input.scope==="future"?group.slice(index):group;
      }
      const delta=Math.round((Date.parse(input.day+"T00:00:00.000Z") -
        Date.parse(dateAnchor.day+"T00:00:00.000Z"))/86400000);
      const changed=selected.map(row=>{
        const day=dayOffset(row.day,delta);
        const slot=validateFixedSlot(day,input.startMinute,input.durationMinutes);
        return {id:row.id,title:input.title,...slot};
      });
      // No partial writes if one moved occurrence would conflict with a study plan.
      this.guardStudyConflicts(changed);
      const apply=this.db.prepare(
        "UPDATE fixed_events SET title=?,day=?,start_minute=?,duration_minutes=? "+
        "WHERE id=? AND source='manual' AND series_id=?");
      for(const row of changed){
        if(Number(apply.run(row.title,row.day,row.startMinute,
          row.durationMinutes,row.id,anchor.series_id).changes)!==1)
          throw Error("Recurring course changed during editing");
        this.enqueueManualEvent(row.id);
      }
      this.db.exec("COMMIT");
      const selectedIds=new Set(changed.map(row=>row.id));
      return this.list().filter(item=>selectedIds.has(item.id));
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /** Delete only entries explicitly belonging to this occurrence's stored series. */
  deleteSeries(id:unknown):number{
    if(typeof id!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(id))
      throw Error("Invalid calendar event identifier");
    const row=this.db.prepare("SELECT series_id FROM fixed_events WHERE id=?")
      .get(id) as {series_id:string|null}|undefined;
    if(!row?.series_id)throw Error("This event is not part of an editable series");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const enrolled=this.db.prepare(`
        SELECT e.owner_id,e.event_id,e.server_version FROM manual_calendar_sync_enrollment e
        JOIN fixed_events f ON f.id=e.event_id WHERE f.series_id=?
        ORDER BY e.owner_id,e.event_id
      `).all(row.series_id) as unknown as {owner_id:string;event_id:string;server_version:number|null}[];
      const stamp=new Date().toISOString();
      for(const item of enrolled){
        if(item.server_version!==null){
          this.db.prepare(`
            INSERT INTO manual_calendar_sync_outbox(owner_id,operation_id,entity_id,action,base_version,payload,created_at)
            VALUES(?,?,?,'delete',?,NULL,?)
            ON CONFLICT(owner_id,entity_id) DO UPDATE SET operation_id=excluded.operation_id,
              action='delete',base_version=excluded.base_version,payload=NULL,created_at=excluded.created_at
          `).run(item.owner_id,randomUUID(),item.event_id,item.server_version,stamp);
        }else{
          this.db.prepare("DELETE FROM manual_calendar_sync_outbox WHERE owner_id=? AND entity_id=?")
            .run(item.owner_id,item.event_id);
        }
      }
      // Series deletion applies to ICS imports as before; only manually enrolled
      // occurrences above can have personal-sync tombstones.
      const removed=Number(this.db.prepare("DELETE FROM fixed_events WHERE series_id=?")
        .run(row.series_id).changes);
      this.db.exec("COMMIT");
      return removed;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /** Import exactly the previewed snapshot; dedup by UID, never overwrite local edits. */
  import(events:ReadonlyArray<FixedEventDraft>,now=new Date()):ICSImportResult{
    if(!Array.isArray(events)||events.length===0||events.length>250)throw Error("Invalid ICS preview");
    const known=new Set(this.list().flatMap(e=>e.sourceUid
      ? [e.sourceUid,e.id+"@ate.local"] : [e.id+"@ate.local"]));
    const incoming=events.filter(e=>!known.has(e.sourceUid??""));
    if(new Set(events.map(e=>e.sourceUid)).size!==events.length)
      throw Error("Duplicate event UID in calendar import");
    for(const event of events){
      validateFixedSlot(event.day,event.startMinute,event.durationMinutes);
      validateFixedTitle(event.title);
      if(!event.sourceUid || event.sourceUid.length>180)throw Error("Invalid ICS UID");
      if(event.seriesKey!==undefined && event.seriesKey!==null &&
        (typeof event.seriesKey!=="string"||event.seriesKey.length>180||
          !/^[!-~]+$/.test(event.seriesKey)))throw Error("Invalid ICS series");
    }
    this.guardCount(incoming.length);
    this.guardStudyConflicts(incoming);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const insert=this.db.prepare(
        "INSERT INTO fixed_events(id,source_uid,series_id,title,day,start_minute,duration_minutes,source,created_at)"+
        " VALUES(?,?,?,?,?,?,?,'ics',?)");
      for(const event of incoming)
        insert.run(randomUUID(),event.sourceUid,event.seriesKey?"ics:"+event.seriesKey:null,
          event.title,event.day,event.startMinute,event.durationMinutes,now.toISOString());
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
    return {added:incoming.length,alreadyPresent:events.length-incoming.length};
  }
}
