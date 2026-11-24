import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {backupBeforeMigration} from "./local-backup";
import {parseICS} from "../shared/ics-calendar";
import {FixedCalendarStore} from "./fixed-calendar-store";
import type {PersonalSyncChange} from "../shared/personal-sync-contract";
import {PlanningStore} from "./planning-store";
import type {BusySlot} from "../shared/fixed-calendar-model";
import type {LocalTask} from "../shared/local-model";
const OWNER_A="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OWNER_B="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const opened:Array<{close:()=>void}>=[];
const folders:string[]=[];
const busy:BusySlot={day:"2026-11-11",startMinute:1080,durationMinutes:60};
function calendar(blocks:()=>BusySlot[]=()=>[]){
  const db=new FixedCalendarStore(":memory:",blocks);opened.push(db);return db;
}
function planner(fixed:()=>BusySlot[]){const db=new PlanningStore(":memory:",fixed);opened.push(db);return db;}
const settings={startDate:"2026-11-11",days:2,dailyStart:"18:00",dailyEnd:"20:00",minutesPerTask:45};
const task:LocalTask={
  id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",title:"Revision",
  description:"",dueDate:"2026-11-15",priority:"normal",completed:false,visible:true,
  hiddenAt:null,retentionExpiresAt:null,source:null,
  createdAt:"2026-11-10T01:00:00Z",updatedAt:"2026-11-10T01:00:00Z",
};
const now=new Date("2026-11-10T01:00:00Z");
afterEach(()=>{while(opened.length)opened.pop()!.close();
  for(const dir of folders.splice(0))rmSync(dir,{recursive:true,force:true});});
describe("fixed classes and selective planning are jointly collision-safe",()=>{
  it("generates manual weekly classes, deduplicates imported UIDs and supports one-off removal",()=>{
    const db=calendar();
    const result=db.create({title:"Physics",day:"2026-11-11",startMinute:540,
      durationMinutes:60,weeks:3},now);
    expect(result.map(x=>x.day)).toEqual(["2026-11-11","2026-11-18","2026-11-25"]);
    const imported={title:"External",day:"2026-11-12",startMinute:600,
      durationMinutes:60,sourceUid:"uid-1"};
    expect(db.import([imported],now)).toEqual({added:1,alreadyPresent:0});
    expect(db.import([imported],now)).toEqual({added:0,alreadyPresent:1});
    expect(db.import([{title:result[0].title,day:result[0].day,
      startMinute:result[0].startMinute,durationMinutes:result[0].durationMinutes,
      sourceUid:result[0].id+"@ate.local"}],now)).toEqual({added:0,alreadyPresent:1});
    expect(db.delete(result[0].id)).toBe(true);
    expect(db.list()).toHaveLength(3);
    expect(()=>db.create({title:"No",day:"2026-11-11",startMinute:540,
      durationMinutes:60,weeks:17})).toThrow();
  });

  it("edits only one weekly occurrence while preserving the remaining series",()=>{
    const db=calendar();
    const group=db.create({title:"Calculus",day:"2026-11-11",startMinute:600,
      durationMinutes:60,weeks:4},now);
    expect(new Set(group.map(x=>x.seriesId)).size).toBe(1);
    expect(group[0].seriesId).toMatch(/^manual:/);
    const changed=db.edit({id:group[1].id,title:"Make-up class",
      day:"2026-11-19",startMinute:630,durationMinutes:45});
    expect(changed).toMatchObject({title:"Make-up class",day:"2026-11-19",
      startMinute:630,durationMinutes:45,seriesId:group[0].seriesId});
    expect(db.list().find(x=>x.id===group[0].id)?.title).toBe("Calculus");
    expect(()=>db.edit({id:group[1].id,title:"Forgery",day:"2026-11-19",
      startMinute:630,durationMinutes:45,sourceUid:"forged"})).toThrow("Invalid");
    expect(db.deleteSeries(group[0].id)).toBe(4);
    expect(db.list()).toEqual([]);
    const single=db.create({title:"Independent",day:"2026-12-01",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    expect(()=>db.deleteSeries(single.id)).toThrow("not part");
  });
  it("edits future manual occurrences and then whole series without touching earlier classes",()=>{
    const db=calendar();
    const group=db.create({title:"Calculus",day:"2026-11-11",startMinute:600,
      durationMinutes:60,weeks:4},now);
    const changed=db.editSeries({id:group[1].id,scope:"future",
      title:"Calculus shifted",day:"2026-11-19",startMinute:660,durationMinutes:75});
    expect(changed).toHaveLength(3);
    const after=db.list();
    expect(after.find(x=>x.id===group[0].id)).toMatchObject({
      title:"Calculus",day:"2026-11-11",startMinute:600,durationMinutes:60,
    });
    expect(changed.map(x=>x.day)).toEqual(["2026-11-19","2026-11-26","2026-12-03"]);
    expect(changed.every(x=>x.startMinute===660&&x.durationMinutes===75)).toBe(true);
    const entire=db.editSeries({id:group[2].id,scope:"all",
      title:"Final calculus",day:"2026-11-27",startMinute:570,durationMinutes:45});
    expect(entire).toHaveLength(4);
    // Anchor (third occurrence) was on Nov 26; shifting all by one day.
    expect(entire.map(x=>x.day)).toEqual([
      "2026-11-12","2026-11-20","2026-11-27","2026-12-04",
    ]);
    expect(entire.every(x=>x.title==="Final calculus"&&x.startMinute===570)).toBe(true);
    expect(new Set(entire.map(x=>x.id)).size).toBe(4);
    expect(new Set(entire.map(x=>x.seriesId)).size).toBe(1);
  });

  it("edits only a bounded inclusive interval and preserves outside occurrences",()=>{
    const db=calendar();
    const series=db.create({title:"Statistics",day:"2026-11-11",
      startMinute:480,durationMinutes:60,weeks:6},now);
    const original=db.list();
    const change=db.editSeries({id:series[0].id,scope:"range",
      rangeStartId:series[2].id,rangeEndId:series[4].id,
      title:"Statistics workshop",day:"2026-11-26",
      startMinute:600,durationMinutes:90});
    expect(change.map(x=>x.id)).toEqual(series.slice(2,5).map(x=>x.id));
    expect(change.map(x=>x.day)).toEqual(["2026-11-26","2026-12-03","2026-12-10"]);
    const after=db.list();
    for(const originalItem of original.filter(x=>
      x.id===series[0].id||x.id===series[1].id||x.id===series[5].id)){
      expect(after.find(x=>x.id===originalItem.id)).toEqual(originalItem);
    }
    expect(after.filter(x=>change.some(c=>c.id===x.id)).every(x=>
      x.title==="Statistics workshop"&&x.startMinute===600)).toBe(true);
  });
  it("rejects reversed endpoints, foreign series and conflicting middle occurrences atomically",()=>{
    const occupied:BusySlot={day:"2026-12-03",startMinute:600,durationMinutes:90};
    const db=calendar(()=>[occupied]);
    const series=db.create({title:"Economics",day:"2026-11-11",
      startMinute:480,durationMinutes:60,weeks:6},now);
    const other=db.create({title:"Chemistry",day:"2026-11-12",
      startMinute:480,durationMinutes:60,weeks:2},now);
    const original=db.list();
    const payload={id:series[0].id,scope:"range" as const,
      rangeStartId:series[2].id,rangeEndId:series[4].id,
      title:"Changed",day:"2026-11-26",startMinute:600,durationMinutes:90};
    expect(()=>db.editSeries(payload)).toThrow("overlaps");
    expect(()=>db.editSeries({...payload,rangeStartId:series[4].id,rangeEndId:series[2].id}))
      .toThrow("range");
    expect(()=>db.editSeries({...payload,rangeEndId:other[0].id})).toThrow("range");
    expect(db.list()).toEqual(original);
  });

  it("rejects a conflicting future course edit atomically, preserving all rows",()=>{
    const busySlot:BusySlot={day:"2026-11-26",startMinute:540,durationMinutes:60};
    const db=calendar(()=>[busySlot]);
    const group=db.create({title:"Physics",day:"2026-11-11",startMinute:600,
      durationMinutes:60,weeks:4},now);
    const before=db.list();
    // Second member Nov18 -> Nov19; third member Nov25 -> Nov26 conflicts.
    expect(()=>db.editSeries({id:group[1].id,scope:"future",
      title:"Blocked",day:"2026-11-19",startMinute:540,durationMinutes:60}))
      .toThrow("overlaps");
    expect(db.list()).toEqual(before);
  });

  it("prohibits bulk edits of ICS and ungrouped manual events, rejects forged scope",()=>{
    const db=calendar();
    const single=db.create({title:"One-off",day:"2026-11-11",
      startMinute:480,durationMinutes:60,weeks:1},now)[0];
    expect(()=>db.editSeries({id:single.id,scope:"all",title:"Forged",
      day:"2026-11-12",startMinute:480,durationMinutes:60})).toThrow("manually created");
    const imported=[
      {title:"ICS class",day:"2026-11-13",startMinute:600,durationMinutes:60,
        sourceUid:"import-1",seriesKey:"weekly-ics"},
      {title:"ICS class",day:"2026-11-20",startMinute:600,durationMinutes:60,
        sourceUid:"import-2",seriesKey:"weekly-ics"},
    ];
    db.import(imported,now);
    const ics=db.list().find(x=>x.source==="ics")!;
    expect(()=>db.editSeries({id:ics.id,scope:"all",title:"Blocked",
      day:"2026-11-14",startMinute:600,durationMinutes:60})).toThrow("manually created");
    const recurring=db.create({title:"Manual",day:"2026-11-14",
      startMinute:700,durationMinutes:60,weeks:2},now);
    expect(()=>db.editSeries({id:recurring[0].id,scope:"untrusted",
      title:"X",day:"2026-11-15",startMinute:700,durationMinutes:60})).toThrow("scope");
    expect(()=>db.editSeries({id:recurring[0].id,scope:"future",
      title:"X",day:"2026-11-15",startMinute:700,durationMinutes:60,
      sourceUid:"forged"})).toThrow("scope");
    expect(db.list().filter(x=>x.source==="ics")).toHaveLength(2);
  });

  it("preserves manually edited occurrences in a stable series across reopen",()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-series-edit-"));folders.push(dir);
    const file=join(dir,"calendar.sqlite");
    const initial=new FixedCalendarStore(file);
    const group=initial.create({title:"History",day:"2026-11-11",
      startMinute:600,durationMinutes:60,weeks:3},now);
    initial.edit({id:group[0].id,title:"One-off changed",
      day:"2026-11-10",startMinute:540,durationMinutes:45});
    initial.close();
    const reopened=new FixedCalendarStore(file);
    const changed=reopened.editSeries({id:group[1].id,scope:"future",
      title:"From second",day:"2026-11-19",startMinute:630,durationMinutes:60});
    expect(changed).toHaveLength(2);
    const first=reopened.list().find(x=>x.id===group[0].id)!;
    expect(first).toMatchObject({title:"One-off changed",day:"2026-11-10"});
    reopened.close();
  });
  it("deduplicates weekly RRULE occurrences and deletes an imported series atomically",()=>{
    const db=calendar();
    const input="BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:weekly-uid\nSUMMARY:Physics\n"+
      "DTSTART:20261109T090000\nDTEND:20261109T100000\n"+
      "RRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\nEND:VCALENDAR\n";
    const events=parseICS(input);
    expect(db.import(events)).toEqual({added:3,alreadyPresent:0});
    expect(db.import(events)).toEqual({added:0,alreadyPresent:3});
    const stored=db.list();
    expect(new Set(stored.map(x=>x.seriesId)).size).toBe(1);
    expect(stored[0].seriesId).toBe("ics:weekly-uid");
    expect(db.deleteSeries(stored[0].id)).toBe(3);
    expect(db.list()).toEqual([]);
  });
  it("retains v1 events and verified backup when upgrading the calendar to owner-scoped schema v5",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-calendar-v1-"));folders.push(dir);
    const path=join(dir,"ate-fixed-calendar.sqlite");
    const initial=new FixedCalendarStore(path);
    const event=initial.create({title:"Legacy class",day:"2026-11-11",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    initial.close();
    const old=new DatabaseSync(path);
    old.exec("DROP TABLE manual_calendar_sync_outbox; DROP TABLE manual_calendar_sync_enrollment; "+
      "DROP TABLE manual_calendar_sync_legacy_outbox; DROP TABLE manual_calendar_sync_legacy_enrollment; "+
      "DROP TABLE canvas_calendar_events; DROP INDEX fixed_events_series; "+
      "ALTER TABLE fixed_events DROP COLUMN series_id; PRAGMA user_version=1;");
    old.close();
    const copied=await backupBeforeMigration(dir,"ate-fixed-calendar.sqlite",5);
    expect(copied).toBeTruthy();
    const pre=new DatabaseSync(join(copied!,"ate-fixed-calendar.sqlite"),{readOnly:true});
    expect((pre.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(1);
    pre.close();
    const restored=new FixedCalendarStore(path);
    expect(restored.list()).toMatchObject([{id:event.id,title:event.title,seriesId:null}]);
    expect(restored.create({title:"New weekly",day:"2026-11-12",
      startMinute:600,durationMinutes:60,weeks:2})).toHaveLength(2);
    restored.close();
    expect(await backupBeforeMigration(dir,"ate-fixed-calendar.sqlite",5)).toBeNull();
  }, 15_000);
  it("offline proposals skip fixed time, AI proposals reject fixed time, apply rechecks edits",()=>{
    const classes=calendar(),p=planner(()=>classes.busySlots());
    classes.create({title:"Calculus",day:busy.day,startMinute:busy.startMinute,
      durationMinutes:busy.durationMinutes,weeks:1});
    const proposal=p.propose(settings,[task],now);
    expect(proposal.blocks[0].startMinute).toBe(1140);
    expect(()=>p.proposeFromAI(settings,[task],[{taskId:task.id,day:busy.day,startMinute:1080}],now))
      .toThrow("fixed");
    expect(()=>p.apply({proposalId:proposal.id,blockIds:[proposal.blocks[0].id],
      edits:[{blockId:proposal.blocks[0].id,day:busy.day,startMinute:1080}]},[task],now))
      .toThrow("fixed");
    expect(p.listCommitted()).toHaveLength(0);
  });
  it("rejects an imported collision with committed study time, preserving imported batch atomicity",()=>{
    let p:PlanningStore;
    const classes=calendar(()=>p.listCommitted());
    p=planner(()=>classes.busySlots());
    const plan=p.propose(settings,[task],now);
    p.apply({proposalId:plan.id,blockIds:[plan.blocks[0].id],edits:[]},[task],now);
    expect(()=>classes.create({title:"Locked class",day:"2026-11-11",
      startMinute:1080,durationMinutes:60,weeks:1})).toThrow("overlaps");
    expect(()=>classes.import([
      {title:"Allowed",day:"2026-11-12",startMinute:900,durationMinutes:60,sourceUid:"allowed"},
      {title:"Blocked",day:"2026-11-11",startMinute:1080,durationMinutes:60,sourceUid:"blocked"},
    ],now)).toThrow("overlaps");
    expect(classes.list()).toHaveLength(0);
    expect(p.listCommitted()).toHaveLength(1);
  });

  it("migrates v4 ownerless calendar sync rows into quarantine and requires explicit re-authorization",()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-calendar-owner-migration-"));
    folders.push(dir);
    const file=join(dir,"calendar.sqlite");
    const initial=new FixedCalendarStore(file);
    const event=initial.create({title:"Legacy manual class",day:"2026-11-12",
      startMinute:540,durationMinutes:60,weeks:1},now)[0];
    initial.close();
    const raw=new DatabaseSync(file);
    raw.exec(`
      DROP TABLE manual_calendar_sync_enrollment;
      DROP TABLE manual_calendar_sync_outbox;
      DROP TABLE manual_calendar_sync_legacy_enrollment;
      DROP TABLE manual_calendar_sync_legacy_outbox;
      CREATE TABLE manual_calendar_sync_enrollment(
        event_id TEXT PRIMARY KEY REFERENCES fixed_events(id) ON DELETE CASCADE,
        server_version INTEGER,enabled_at TEXT NOT NULL
      );
      CREATE TABLE manual_calendar_sync_outbox(
        operation_id TEXT PRIMARY KEY,entity_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK(action IN('upsert','delete')),
        base_version INTEGER,payload TEXT,created_at TEXT NOT NULL,
        CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
      );
    `);
    raw.prepare("INSERT INTO manual_calendar_sync_enrollment VALUES(?,?,?)")
      .run(event.id,8,"2026-11-20T10:00:00.000Z");
    raw.prepare("INSERT INTO manual_calendar_sync_outbox VALUES(?,?,?,?,?,?)")
      .run("44444444-4444-4444-8444-444444444444",event.id,"upsert",8,
        JSON.stringify({title:"stale",day:event.day,startMinute:540,durationMinutes:60,seriesId:null}),
        "2026-11-20T10:01:00.000Z");
    raw.prepare("INSERT INTO manual_calendar_sync_outbox VALUES(?,?,?,?,?,?)")
      .run("55555555-5555-4555-8555-555555555555","66666666-6666-4666-8666-666666666666",
        "delete",12,null,"2026-11-20T10:02:00.000Z");
    raw.exec("PRAGMA user_version=4");
    raw.close();

    const upgraded=new FixedCalendarStore(file);
    expect(upgraded.list()).toMatchObject([{id:event.id,title:event.title}]);
    expect(upgraded.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    expect(upgraded.listManualCalendarSyncOutbox(OWNER_B)).toEqual([]);
    expect(upgraded.listLegacyManualCalendarSyncItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({entityId:event.id,action:"upsert",canReauthorize:true}),
      expect.objectContaining({entityId:"66666666-6666-4666-8666-666666666666",action:"delete",canReauthorize:false}),
    ]));
    expect(()=>upgraded.adoptLegacyManualEventSync(OWNER_B,event.id,false,now)).toThrow("Explicit confirmation");
    upgraded.adoptLegacyManualEventSync(OWNER_B,event.id,true,now);
    expect(upgraded.listManualCalendarSyncOutbox(OWNER_B)).toMatchObject([
      {entityId:event.id,action:"upsert",baseVersion:null},
    ]);
    expect(JSON.parse(upgraded.listManualCalendarSyncOutbox(OWNER_B)[0].payload!).title).toBe(event.title);
    expect(upgraded.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    expect(upgraded.listLegacyManualCalendarSyncItems()).toMatchObject([
      {entityId:"66666666-6666-4666-8666-666666666666",action:"delete",canReauthorize:false},
    ]);
    expect(()=>upgraded.adoptLegacyManualEventSync(OWNER_A,
      "66666666-6666-4666-8666-666666666666",true,now)).toThrow("existing manual event");
    upgraded.close();
  });

  it("enrolls only a selected manual calendar event and queues a strict snapshot",()=>{
    const db=calendar();
    const event=db.create({title:"手动课程",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const queued=db.listManualCalendarSyncOutbox(OWNER_A);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({entityId:event.id,action:"upsert",baseVersion:null});
    expect(JSON.parse(queued[0].payload!)).toMatchObject({title:"手动课程",day:"2026-11-12",startMinute:540,durationMinutes:60,seriesId:null});
  });
  it("isolates manual calendar enrollment and outbox entries by cloud owner",()=>{
    const db=calendar();
    const event=db.create({title:"Two account event",day:"2026-11-12",
      startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    db.setManualEventSyncEnabled(event.id,true,OWNER_B,now);
    const a=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    const b=db.listManualCalendarSyncOutbox(OWNER_B)[0];
    expect(a.operationId).not.toBe(b.operationId);
    expect(db.acknowledgeManualCalendarSyncOperation(OWNER_B,a.operationId,event.id,"upsert",5,null)).toBe("not-pending");
    expect(db.listManualCalendarSyncOutbox(OWNER_B)[0].operationId).toBe(b.operationId);
    db.edit({id:event.id,title:"Updated for both accounts",day:event.day,
      startMinute:600,durationMinutes:60});
    expect(db.listManualCalendarSyncOutbox(OWNER_A)[0].operationId).not.toBe(a.operationId);
    expect(db.listManualCalendarSyncOutbox(OWNER_B)[0].operationId).not.toBe(b.operationId);
    const latestA=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,latestA.operationId,event.id,"upsert",6,null);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    expect(db.listManualCalendarSyncOutbox(OWNER_B)).toHaveLength(1);
    db.setManualEventSyncEnabled(event.id,false,OWNER_B,now);
    expect(db.listManualCalendarSyncOutbox(OWNER_B)).toEqual([]);
    expect(db.listManualCalendarSyncEnrollments(OWNER_A)).toHaveLength(1);
    expect(db.listManualCalendarSyncEnrollments(OWNER_B)).toEqual([]);
  });

  it("writes one delete tombstone per acknowledged owner and cancels pending creates",()=>{
    const db=calendar();
    const event=db.create({title:"Delete across accounts",day:"2026-11-12",
      startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    db.setManualEventSyncEnabled(event.id,true,OWNER_B,now);
    const a=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,a.operationId,event.id,"upsert",11,null);
    expect(db.delete(event.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toMatchObject([
      {entityId:event.id,action:"delete",baseVersion:11,payload:null},
    ]);
    expect(db.listManualCalendarSyncOutbox(OWNER_B)).toEqual([]);
  });

  it("coalesces manual event edits while rotating the idempotency key for new payloads",()=>{
    const db=calendar();
    const event=db.create({title:"旧标题",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const first=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.edit({id:event.id,title:"新标题",day:"2026-11-12",startMinute:600,durationMinutes:60});
    const latest=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    expect(latest.operationId).not.toBe(first.operationId);
    expect(JSON.parse(latest.payload!).title).toBe("新标题");
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,latest.operationId,event.id,"upsert",3,null);
    db.edit({id:event.id,title:"再次编辑",day:"2026-11-12",startMinute:660,durationMinutes:60});
    expect(db.listManualCalendarSyncOutbox(OWNER_A)[0].baseVersion).toBe(3);
  });
  it("lists only manually created calendar events as personal sync candidates",()=>{
    const db=calendar();
    const manual=db.create({title:"Manual candidate",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.import([{title:"ICS candidate",day:"2026-11-13",startMinute:540,
      durationMinutes:60,sourceUid:"ics-candidate"}],now);
    expect(db.listManualCalendarSyncCandidates(OWNER_A)).toMatchObject([
      {entityType:"manual-calendar-event",entityId:manual.id,title:"Manual candidate",enabled:false},
    ]);
    db.setManualEventSyncEnabled(manual.id,true,OWNER_A,now);
    expect(db.listManualCalendarSyncCandidates(OWNER_A)[0].enabled).toBe(true);
    expect(db.listManualCalendarSyncCandidates(OWNER_B)[0].enabled).toBe(false);
    expect(db.countManualCalendarSyncOutbox(OWNER_A)).toBe(1);
    expect(db.countManualCalendarSyncOutbox(OWNER_B)).toBe(0);
  });

  it("applies remote manual calendar snapshots and preserves a conflicting local edit",()=>{
    const db=calendar();
    const entityId="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
    const first:PersonalSyncChange={cursor:"1",entityType:"manual-calendar-event",entityId,version:1,
      payload:{title:"Remote class",day:"2026-11-12",startMinute:540,durationMinutes:60,seriesId:null},
      deleted:false,updatedAt:"2026-11-20T10:00:00.000Z"};
    expect(db.applyRemoteManualCalendarChanges(OWNER_A,[first])).toEqual([]);
    expect(db.list()).toMatchObject([{id:entityId,title:"Remote class",source:"manual"}]);
    expect(db.listManualCalendarSyncEnrollments(OWNER_A)).toMatchObject([{eventId:entityId,serverVersion:1}]);
    db.edit({id:entityId,title:"Local class edit",day:"2026-11-12",startMinute:600,durationMinutes:60});
    const second:PersonalSyncChange={...first,cursor:"2",version:2,
      payload:{title:"Remote class edit",day:"2026-11-13",startMinute:660,durationMinutes:90,seriesId:null},
      updatedAt:"2026-11-20T10:01:00.000Z"};
    const conflicts=db.applyRemoteManualCalendarChanges(OWNER_A,[second]);
    expect(conflicts).toMatchObject([{
      entityId,localAction:"upsert",remoteVersion:2,reason:"remote-change-while-local-pending",
    }]);
    expect(db.list()).toMatchObject([{id:entityId,title:"Local class edit",startMinute:600}]);
  });

  it("applies remote calendar deletes only when no local edit is pending",()=>{
    const db=calendar();
    const entityId="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
    const first:PersonalSyncChange={cursor:"1",entityType:"manual-calendar-event",entityId,version:1,
      payload:{title:"Remote class",day:"2026-11-12",startMinute:540,durationMinutes:60,seriesId:null},
      deleted:false,updatedAt:"2026-11-20T10:00:00.000Z"};
    db.applyRemoteManualCalendarChanges(OWNER_A,[first]);
    const deletion:PersonalSyncChange={...first,cursor:"2",version:2,payload:null,deleted:true,
      updatedAt:"2026-11-20T10:01:00.000Z"};
    expect(db.applyRemoteManualCalendarChanges(OWNER_A,[deletion])).toEqual([]);
    expect(db.list()).toEqual([]);
    expect(db.listManualCalendarSyncEnrollments(OWNER_A)).toEqual([]);
  });

  it("rebases an in-flight manual event create when a newer local edit is acknowledged",()=>{
    const db=calendar();
    const event=db.create({title:"Before push",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const sent=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.edit({id:event.id,title:"Edited during push",day:event.day,startMinute:600,durationMinutes:60});
    const newer=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    expect(newer.operationId).not.toBe(sent.operationId);
    expect(db.acknowledgeManualCalendarSyncOperation(OWNER_A,sent.operationId,event.id,"upsert",1,null))
      .toBe("not-pending");
    expect(db.rebaseManualCalendarSyncOperation(OWNER_A,event.id,"upsert",1,null)).toBe("superseded");
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toMatchObject([
      {operationId:newer.operationId,baseVersion:1},
    ]);
  });

  it("creates a compensating calendar delete if an event is removed during its first upload",()=>{
    const db=calendar();
    const event=db.create({title:"Delete during push",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const sent=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    expect(db.delete(event.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    expect(db.acknowledgeManualCalendarSyncOperation(OWNER_A,sent.operationId,event.id,"upsert",1,null))
      .toBe("not-pending");
    expect(db.rebaseManualCalendarSyncOperation(OWNER_A,event.id,"upsert",1,null))
      .toBe("deleted-during-upload");
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toMatchObject([
      {entityId:event.id,action:"delete",baseVersion:1,payload:null},
    ]);
  });

  it("keeps local manual calendar edits only after conflict CAS and rebase",()=>{
    const db=calendar();
    const event=db.create({title:"Before sync",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const sent=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,sent.operationId,event.id,"upsert",1,null);
    db.edit({id:event.id,title:"Local choice",day:event.day,startMinute:600,durationMinutes:60});
    const pending=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    const remote:PersonalSyncChange={cursor:"2",entityType:"manual-calendar-event",
      entityId:event.id,version:2,payload:{title:"Elsewhere",day:"2026-11-13",
        startMinute:720,durationMinutes:75,seriesId:null},
      deleted:false,updatedAt:"2026-11-24T11:00:00.000Z"};
    const conflict=db.applyRemoteManualCalendarChanges(OWNER_A,[remote])[0];
    const record={...conflict,createdAt:"2026-11-24T11:00:00.000Z",
      updatedAt:"2026-11-24T11:00:00.000Z"};
    const request={entityType:"manual-calendar-event" as const,entityId:event.id,
      remoteVersion:2,localOperationId:pending.operationId,choice:"keep-local" as const};
    expect(()=>db.resolveManualCalendarConflict(OWNER_A,record,{...request,remoteVersion:3}))
      .toThrow("changed");
    db.resolveManualCalendarConflict(OWNER_A,record,request);
    expect(db.list()).toMatchObject([{id:event.id,title:"Local choice",startMinute:600}]);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toMatchObject([
      {action:"upsert",baseVersion:2},
    ]);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)[0].operationId).not.toBe(pending.operationId);
  });

  it("adopts a reviewed remote manual calendar version with the local edit canceled",()=>{
    const db=calendar();
    const event=db.create({title:"Initial",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const first=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,first.operationId,event.id,"upsert",1,null);
    db.edit({id:event.id,title:"Local draft",day:event.day,startMinute:600,durationMinutes:60});
    const pending=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    const remote:PersonalSyncChange={cursor:"2",entityType:"manual-calendar-event",
      entityId:event.id,version:2,payload:{title:"Accepted remote",day:"2026-11-13",
        startMinute:660,durationMinutes:90,seriesId:null},
      deleted:false,updatedAt:"2026-11-24T11:00:00.000Z"};
    const conflict=db.applyRemoteManualCalendarChanges(OWNER_A,[remote])[0];
    db.resolveManualCalendarConflict(OWNER_A,{...conflict,
      createdAt:"2026-11-24T11:00:00.000Z",updatedAt:"2026-11-24T11:00:00.000Z"},{
      entityType:"manual-calendar-event",entityId:event.id,remoteVersion:2,
      localOperationId:pending.operationId,choice:"use-remote",
    });
    expect(db.list()).toMatchObject([{id:event.id,title:"Accepted remote",
      day:"2026-11-13",startMinute:660,durationMinutes:90}]);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
    expect(db.listManualCalendarSyncEnrollments(OWNER_A)).toMatchObject([{serverVersion:2}]);
  });

  it("blocks adopting a remote calendar slot that overlaps confirmed study time",()=>{
    const db=calendar(()=>[busy]);
    const event=db.create({title:"Safe local",day:"2026-11-12",startMinute:540,
      durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    const first=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,first.operationId,event.id,"upsert",1,null);
    db.edit({id:event.id,title:"Local edit",day:event.day,startMinute:600,durationMinutes:60});
    const pending=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    const remote:PersonalSyncChange={cursor:"2",entityType:"manual-calendar-event",
      entityId:event.id,version:2,payload:{title:"Conflicting",day:busy.day,
        startMinute:busy.startMinute,durationMinutes:busy.durationMinutes,seriesId:null},
      deleted:false,updatedAt:"2026-11-24T11:00:00.000Z"};
    const conflict=db.applyRemoteManualCalendarChanges(OWNER_A,[remote])[0];
    expect(()=>db.resolveManualCalendarConflict(OWNER_A,{...conflict,
      createdAt:"2026-11-24T11:00:00.000Z",updatedAt:"2026-11-24T11:00:00.000Z"},{
      entityType:"manual-calendar-event",entityId:event.id,remoteVersion:2,
      localOperationId:pending.operationId,choice:"use-remote",
    })).toThrow("overlaps");
    expect(db.list()).toMatchObject([{id:event.id,title:"Local edit",day:"2026-11-12"}]);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)[0].operationId).toBe(pending.operationId);
  });

  it("does not enroll imported ICS records and retains remote delete tombstones",()=>{
    const db=calendar();
    db.import([{title:"ICS",day:"2026-11-12",startMinute:540,durationMinutes:60,sourceUid:"ics-uid"}],now);
    const imported=db.list()[0];
    expect(()=>db.setManualEventSyncEnabled(imported.id,true,OWNER_A)).toThrow();
    const manual=db.create({title:"手动",day:"2026-11-13",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(manual.id,true,OWNER_A,now);
    const create=db.listManualCalendarSyncOutbox(OWNER_A)[0];
    db.acknowledgeManualCalendarSyncOperation(OWNER_A,create.operationId,manual.id,"upsert",8,null);
    expect(db.delete(manual.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toMatchObject([{entityId:manual.id,action:"delete",baseVersion:8,payload:null}]);
  });
  it("cancels a never-acknowledged manual event create when it is deleted",()=>{
    const db=calendar();
    const event=db.create({title:"未同步",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,OWNER_A,now);
    expect(db.delete(event.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox(OWNER_A)).toEqual([]);
  });


  it("writes per-occurrence tombstones when deleting an enrolled manual series",()=>{
    const db=calendar();
    const group=db.create({title:"手动系列",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:2},now);
    for(let index=0;index<group.length;index++){
      db.setManualEventSyncEnabled(group[index].id,true,OWNER_A,now);
      db.setManualEventSyncEnabled(group[index].id,true,OWNER_B,now);
      const operationA=db.listManualCalendarSyncOutbox(OWNER_A).find(x=>x.entityId===group[index].id)!;
      const operationB=db.listManualCalendarSyncOutbox(OWNER_B).find(x=>x.entityId===group[index].id)!;
      db.acknowledgeManualCalendarSyncOperation(OWNER_A,operationA.operationId,group[index].id,"upsert",10+index,null);
      db.acknowledgeManualCalendarSyncOperation(OWNER_B,operationB.operationId,group[index].id,"upsert",20+index,null);
    }
    expect(db.deleteSeries(group[0].id)).toBe(2);
    expect(db.list()).toHaveLength(0);
    const tombstonesA=db.listManualCalendarSyncOutbox(OWNER_A);
    const tombstonesB=db.listManualCalendarSyncOutbox(OWNER_B);
    expect(tombstonesA).toHaveLength(2);
    expect(tombstonesB).toHaveLength(2);
    expect(tombstonesA.find(x=>x.entityId===group[0].id))
      .toMatchObject({action:"delete",baseVersion:10,payload:null});
    expect(tombstonesA.find(x=>x.entityId===group[1].id))
      .toMatchObject({action:"delete",baseVersion:11,payload:null});
    expect(tombstonesB.find(x=>x.entityId===group[0].id))
      .toMatchObject({action:"delete",baseVersion:20,payload:null});
    expect(tombstonesB.find(x=>x.entityId===group[1].id))
      .toMatchObject({action:"delete",baseVersion:21,payload:null});
  });

});
