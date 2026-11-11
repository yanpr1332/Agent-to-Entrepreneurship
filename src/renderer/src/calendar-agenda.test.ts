import {describe,expect,it} from "vitest";
import type {LocalTask} from "../../shared/local-model";
import type {PlanBlock} from "../../shared/planning-model";
import type {CalendarDisplayEvent} from "../../shared/canvas-calendar-model";
import {
  buildCalendarAgenda,calendarWeekDays,shiftCalendarDay,shiftCalendarMonth,
  shiftCalendarView,startOfCalendarWeek,
} from "./calendar-agenda";

function task(id:string,dueDate:string|null,props:Partial<LocalTask>={}):LocalTask{
  return {id,title:"Homework "+id,description:"",dueDate,priority:"normal",completed:false,
    visible:true,source:null,hiddenAt:null,retentionExpiresAt:null,
    createdAt:"2026-11-11T00:00:00Z",updatedAt:"2026-11-11T00:00:00Z",...props};
}
const study={
  id:"study-1",taskId:"task-1",taskTitle:"Study calculus",day:"2026-11-11",
  startMinute:600,durationMinutes:60,
} as PlanBlock;
const fixed={
  id:"fixed-1",title:"Calculus lecture",source:"manual",
  day:"2026-11-11",startMinute:630,durationMinutes:60,
  sourceUid:null,seriesId:null,createdAt:"2026-11-10T00:00:00Z",
} as CalendarDisplayEvent;
const canvas={
  ...fixed,id:"canvas-1",source:"canvas",title:"Imported lecture",visible:true,
  missing:false,courseId:9,accountId:42,instanceOrigin:"https://school.edu",remoteId:100,
  lastSyncedAt:"2026-11-10T00:00:00Z",retentionExpiresAt:null,
} as CalendarDisplayEvent;

describe("calendar navigation uses device civil dates",()=>{
  it("returns Monday-first seven-day windows across year and month boundaries",()=>{
    expect(startOfCalendarWeek("2027-01-01")).toBe("2026-12-28");
    expect(calendarWeekDays("2027-01-01")).toEqual([
      "2026-12-28","2026-12-29","2026-12-30",
      "2026-12-31","2027-01-01","2027-01-02","2027-01-03",
    ]);
    expect(calendarWeekDays("2026-11-11")).toHaveLength(7);
  });
  it("handles leap years and clamps month-end instead of overflowing",()=>{
    expect(shiftCalendarMonth("2028-01-31",1)).toBe("2028-02-29");
    expect(shiftCalendarMonth("2027-01-31",1)).toBe("2027-02-28");
    expect(shiftCalendarDay("2028-02-28",1)).toBe("2028-02-29");
    expect(shiftCalendarDay("2027-12-31",1)).toBe("2028-01-01");
    expect(shiftCalendarView("2026-11-11","day",-1)).toBe("2026-11-10");
    expect(shiftCalendarView("2026-11-11","week",1)).toBe("2026-11-18");
    expect(()=>shiftCalendarDay("2026-02-30",1)).toThrow("Invalid");
  });
});
describe("combined daily and weekly agenda",()=>{
  it("keeps deadline tasks distinct from occupied time blocks",()=>{
    const result=buildCalendarAgenda(["2026-11-11"],[
      task("1","2026-11-11",{priority:"high"}),
      task("2","2026-11-11",{completed:true}),
      task("3",null),
      task("4","2026-11-11",{visible:false}),
    ],[],[]);
    expect(result[0].timed).toEqual([]);
    expect(result[0].deadlines.map(x=>x.id)).toEqual(["1","2"]);
  });
  it("sorts fixed events and study blocks by clock time and flags both sides of overlap",()=>{
    const result=buildCalendarAgenda(["2026-11-11"],[],[study],[fixed]);
    expect(result[0].timed.map(x=>({kind:x.kind,start:x.startMinute,conflict:x.conflict})))
      .toEqual([
        {kind:"study",start:600,conflict:true},
        {kind:"fixed",start:630,conflict:true},
      ]);
    const adjacent=buildCalendarAgenda(["2026-11-11"],[],[
      {...study,durationMinutes:30},
    ],[{...fixed,startMinute:630}]);
    expect(adjacent[0].timed.every(x=>!x.conflict)).toBe(true);
  });
  it("never shows hidden/missing Canvas events or counts them as conflicts",()=>{
    const base=[study] as PlanBlock[];
    const hidden={...canvas,visible:false} as CalendarDisplayEvent;
    const missing={...canvas,id:"canvas-2",missing:true} as CalendarDisplayEvent;
    expect(buildCalendarAgenda(["2026-11-11"],[],base,[hidden,missing])[0].timed)
      .toMatchObject([{kind:"study",conflict:false}]);
    const shown=buildCalendarAgenda(["2026-11-11"],[],base,[canvas]);
    expect(shown[0].timed.some(x=>x.kind==="canvas"&&x.conflict)).toBe(true);
  });
  it("returns complete empty days in selected order and isolates other dates",()=>{
    const days=calendarWeekDays("2026-11-11");
    const result=buildCalendarAgenda(days,[task("next","2026-12-01")],[],[fixed]);
    expect(result.map(x=>x.day)).toEqual(days);
    expect(result.filter(x=>x.timed.length)).toHaveLength(1);
    expect(result.every(x=>x.deadlines.length===0)).toBe(true);
  });
});
