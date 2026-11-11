import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync,backup } from "node:sqlite";
import { LocalStore } from "./local-store";
import { toLocalCanvasSlot,type CanvasCalendarEvent,type CanvasCalendarFixedEvent,
  type CanvasCalendarSyncResult } from "../shared/canvas-calendar-model";
import type { CalendarDisplayEvent } from "../shared/canvas-calendar-model";
import {
  parseCreateFixedEvent,parseEditFixedEvent,validateFixedSlot,validateFixedTitle,weeklyOccurrences,timesOverlap,
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
    if(version>3)throw Error("Calendar database is from a newer version");
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
  }
  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}
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
    return Number(this.db.prepare("DELETE FROM fixed_events WHERE id=?").run(input).changes)===1;
  }
  /** A single occurrence may be edited, without mutating its parent series. */
  edit(raw:unknown):FixedEvent{
    const input=parseEditFixedEvent(raw);
    this.guardStudyConflicts([input]);
    const updated=this.db.prepare(
      "UPDATE fixed_events SET title=?,day=?,start_minute=?,duration_minutes=? WHERE id=?"
    ).run(input.title,input.day,input.startMinute,input.durationMinutes,input.id);
    if(Number(updated.changes)!==1)throw Error("Calendar event no longer exists");
    const found=this.list().find(item=>item.id===input.id);
    if(!found)throw Error("Calendar event no longer exists");
    return found;
  }
  /** Delete only entries explicitly belonging to this occurrence's stored series. */
  deleteSeries(id:unknown):number{
    if(typeof id!=="string"||!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(id))
      throw Error("Invalid calendar event identifier");
    const row=this.db.prepare("SELECT series_id FROM fixed_events WHERE id=?")
      .get(id) as {series_id:string|null}|undefined;
    if(!row?.series_id)throw Error("This event is not part of an editable series");
    return Number(this.db.prepare("DELETE FROM fixed_events WHERE series_id=?")
      .run(row.series_id).changes);
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
