import {afterEach,describe,expect,it} from "vitest";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {PlanningStore} from "./planning-store";
import type {BusySlot} from "../shared/fixed-calendar-model";
import type {LocalTask} from "../shared/local-model";
const opened:Array<{close:()=>void}>=[];
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
afterEach(()=>{while(opened.length)opened.pop()!.close();});
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
});
