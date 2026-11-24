import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {backupBeforeMigration} from "./local-backup";
import {parseICS} from "../shared/ics-calendar";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PlanningStore} from "./planning-store";
import type {BusySlot} from "../shared/fixed-calendar-model";
import type {LocalTask} from "../shared/local-model";
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
  it("retains v1 events and verified backup when upgrading the calendar to schema v2",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-calendar-v1-"));folders.push(dir);
    const path=join(dir,"ate-fixed-calendar.sqlite");
    const initial=new FixedCalendarStore(path);
    const event=initial.create({title:"Legacy class",day:"2026-11-11",
      startMinute:540,durationMinutes:60,weeks:1})[0];
    initial.close();
    const old=new DatabaseSync(path);
    old.exec("DROP TABLE manual_calendar_sync_outbox; DROP TABLE manual_calendar_sync_enrollment; "+
      "DROP TABLE canvas_calendar_events; DROP INDEX fixed_events_series; "+
      "ALTER TABLE fixed_events DROP COLUMN series_id; PRAGMA user_version=1;");
    old.close();
    const copied=await backupBeforeMigration(dir,"ate-fixed-calendar.sqlite",2);
    expect(copied).toBeTruthy();
    const pre=new DatabaseSync(join(copied!,"ate-fixed-calendar.sqlite"),{readOnly:true});
    expect((pre.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(1);
    pre.close();
    const restored=new FixedCalendarStore(path);
    expect(restored.list()).toMatchObject([{id:event.id,title:event.title,seriesId:null}]);
    expect(restored.create({title:"New weekly",day:"2026-11-12",
      startMinute:600,durationMinutes:60,weeks:2})).toHaveLength(2);
    restored.close();
    expect(await backupBeforeMigration(dir,"ate-fixed-calendar.sqlite",2)).toBeNull();
  });
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

  it("enrolls only a selected manual calendar event and queues a strict snapshot",()=>{
    const db=calendar();
    const event=db.create({title:"手动课程",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    expect(db.listManualCalendarSyncOutbox()).toEqual([]);
    db.setManualEventSyncEnabled(event.id,true,now);
    const queued=db.listManualCalendarSyncOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({entityId:event.id,action:"upsert",baseVersion:null});
    expect(JSON.parse(queued[0].payload!)).toMatchObject({title:"手动课程",day:"2026-11-12",startMinute:540,durationMinutes:60,seriesId:null});
  });
  it("coalesces opted-in manual event edits and carries the acknowledged version",()=>{
    const db=calendar();
    const event=db.create({title:"旧标题",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,now);
    const first=db.listManualCalendarSyncOutbox()[0];
    db.edit({id:event.id,title:"新标题",day:"2026-11-12",startMinute:600,durationMinutes:60});
    const latest=db.listManualCalendarSyncOutbox()[0];
    expect(latest.operationId).toBe(first.operationId);
    expect(JSON.parse(latest.payload!).title).toBe("新标题");
    db.acknowledgeManualCalendarSyncOperation(latest.operationId,3);
    db.edit({id:event.id,title:"再次编辑",day:"2026-11-12",startMinute:660,durationMinutes:60});
    expect(db.listManualCalendarSyncOutbox()[0].baseVersion).toBe(3);
  });
  it("does not enroll imported ICS records and retains remote delete tombstones",()=>{
    const db=calendar();
    db.import([{title:"ICS",day:"2026-11-12",startMinute:540,durationMinutes:60,sourceUid:"ics-uid"}],now);
    const imported=db.list()[0];
    expect(()=>db.setManualEventSyncEnabled(imported.id,true)).toThrow();
    const manual=db.create({title:"手动",day:"2026-11-13",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(manual.id,true,now);
    const create=db.listManualCalendarSyncOutbox()[0];
    db.acknowledgeManualCalendarSyncOperation(create.operationId,8);
    expect(db.delete(manual.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox()).toMatchObject([{entityId:manual.id,action:"delete",baseVersion:8,payload:null}]);
  });
  it("cancels a never-acknowledged manual event create when it is deleted",()=>{
    const db=calendar();
    const event=db.create({title:"未同步",day:"2026-11-12",startMinute:540,durationMinutes:60,weeks:1},now)[0];
    db.setManualEventSyncEnabled(event.id,true,now);
    expect(db.delete(event.id)).toBe(true);
    expect(db.listManualCalendarSyncOutbox()).toEqual([]);
  });

});
