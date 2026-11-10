import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync,backup } from "node:sqlite";
import {
  parseCreateFixedEvent,validateFixedSlot,validateFixedTitle,weeklyOccurrences,timesOverlap,
  type BusySlot,type FixedEvent,type FixedEventDraft,type ICSImportResult,
} from "../shared/fixed-calendar-model";

interface EventRow {
  id:string;source_uid:string|null;title:string;day:string;
  start_minute:number;duration_minutes:number;source:"manual"|"ics";created_at:string;
}
function fromRow(row:EventRow):FixedEvent{
  return {id:row.id,sourceUid:row.source_uid,title:row.title,day:row.day,
    startMinute:row.start_minute,durationMinutes:row.duration_minutes,
    source:row.source,createdAt:row.created_at};
}
const MAX_EVENTS=2000;

/** Independent, local-only authority for fixed classes and imported calendar events. */
export class FixedCalendarStore {
  private readonly db:DatabaseSync;
  constructor(path:string,private readonly studyBlocks:()=>BusySlot[]=()=>[]){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>1)throw Error("Calendar database is from a newer version");
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
  }
  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}
  list():FixedEvent[]{
    return (this.db.prepare("SELECT * FROM fixed_events ORDER BY day,start_minute,id")
      .all() as unknown as EventRow[]).map(fromRow);
  }
  busySlots():BusySlot[]{return this.list().map(({day,startMinute,durationMinutes})=>({day,startMinute,durationMinutes}));}
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
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const put=this.db.prepare(
        "INSERT INTO fixed_events(id,source_uid,title,day,start_minute,duration_minutes,source,created_at)"+
        " VALUES(?,NULL,?,?,?,?,'manual',?)");
      for(const candidate of candidates){
        const id=randomUUID(),stamp=now.toISOString();
        put.run(id,candidate.title,candidate.day,candidate.startMinute,candidate.durationMinutes,stamp);
        created.push({id,...candidate,source:"manual",createdAt:stamp});
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
    }
    this.guardCount(incoming.length);
    this.guardStudyConflicts(incoming);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const insert=this.db.prepare(
        "INSERT INTO fixed_events(id,source_uid,title,day,start_minute,duration_minutes,source,created_at)"+
        " VALUES(?,?,?,?,?,?,'ics',?)");
      for(const event of incoming)
        insert.run(randomUUID(),event.sourceUid,event.title,event.day,event.startMinute,event.durationMinutes,now.toISOString());
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
    return {added:incoming.length,alreadyPresent:events.length-incoming.length};
  }
}
