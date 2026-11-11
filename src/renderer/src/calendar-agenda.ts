import type { LocalTask } from "../../shared/local-model";
import type { CalendarDisplayEvent } from "../../shared/canvas-calendar-model";
import type { PlanBlock } from "../../shared/planning-model";
import { validCivilDay } from "../../shared/planning-model";
import { timesOverlap } from "../../shared/fixed-calendar-model";
import { localDateKey } from "./calendar";

export type CalendarView = "month" | "week" | "day";

export interface AgendaEntry {
  id:string;
  kind:"study"|"fixed"|"canvas";
  day:string;
  title:string;
  startMinute:number;
  durationMinutes:number;
  conflict:boolean;
}
export interface AgendaDay {
  day:string;
  timed:AgendaEntry[];
  deadlines:LocalTask[];
}

/** Use local noon for civil-day arithmetic: never parse YYYY-MM-DD as UTC midnight. */
function noon(day:string):Date {
  if(!validCivilDay(day))throw new Error("Invalid local calendar date");
  const [year,month,date]=day.split("-").map(Number);
  return new Date(year,month-1,date,12);
}
export function shiftCalendarDay(day:string,offset:number):string {
  if(!Number.isSafeInteger(offset)||Math.abs(offset)>3660)throw new Error("Invalid calendar day offset");
  const value=noon(day);
  value.setDate(value.getDate()+offset);
  return localDateKey(value);
}
export function startOfCalendarWeek(day:string):string {
  const value=noon(day);
  return shiftCalendarDay(day,-((value.getDay()+6)%7));
}
export function calendarWeekDays(day:string):string[]{
  const monday=startOfCalendarWeek(day);
  return Array.from({length:7},(_,i)=>shiftCalendarDay(monday,i));
}
/** Navigating months clamps Jan 31 → Feb 28/29 instead of skipping February. */
export function shiftCalendarMonth(day:string,delta:number):string {
  if(!Number.isSafeInteger(delta)||Math.abs(delta)>120)throw new Error("Invalid month offset");
  const value=noon(day);
  const target=new Date(value.getFullYear(),value.getMonth()+delta,1,12);
  const last=new Date(target.getFullYear(),target.getMonth()+1,0,12).getDate();
  target.setDate(Math.min(value.getDate(),last));
  return localDateKey(target);
}
export function shiftCalendarView(day:string,view:CalendarView,direction:-1|1):string {
  return view==="month" ? shiftCalendarMonth(day,direction) :
    shiftCalendarDay(day,direction*(view==="week"?7:1));
}
/**
 * Deadline-only tasks are not time reservations; neither assign midnight to
 * due dates nor include hidden Canvas records in visible calendar data.
 * Only actual fixed events and committed study blocks can overlap.
 */
export function buildCalendarAgenda(
  days:readonly string[],
  tasks:readonly LocalTask[],
  blocks:readonly PlanBlock[],
  events:readonly CalendarDisplayEvent[],
):AgendaDay[]{
  const shownTasks=tasks.filter(t=>t.visible&&t.dueDate!==null);
  const shownEvents=events.filter(e=>e.source!=="canvas"||(e.visible&&!e.missing));
  const daySet=new Set(days);
  const indexed=new Map<string,AgendaEntry[]>();
  for(const block of blocks){
    if(!daySet.has(block.day))continue;
    const list=indexed.get(block.day)??[];
    list.push({id:block.id,kind:"study",day:block.day,title:block.taskTitle,
      startMinute:block.startMinute,durationMinutes:block.durationMinutes,conflict:false});
    indexed.set(block.day,list);
  }
  for(const event of shownEvents){
    if(!daySet.has(event.day))continue;
    const list=indexed.get(event.day)??[];
    list.push({id:event.id,kind:event.source==="canvas"?"canvas":"fixed",
      day:event.day,title:event.title,startMinute:event.startMinute,
      durationMinutes:event.durationMinutes,conflict:false});
    indexed.set(event.day,list);
  }
  return days.map(day=>{
    const records=indexed.get(day)??[];
    const timed=records.map((entry,i)=>({
      ...entry,conflict:records.some((other,j)=>i!==j&&timesOverlap(entry,other)),
    })).sort((a,b)=>a.startMinute-b.startMinute||
      a.durationMinutes-b.durationMinutes||a.id.localeCompare(b.id));
    return {day,timed,deadlines:shownTasks
      .filter(t=>t.dueDate===day)
      .sort((a,b)=>Number(a.completed)-Number(b.completed)||
        ({high:0,normal:1,low:2}[a.priority]-{high:0,normal:1,low:2}[b.priority])||
        a.title.localeCompare(b.title))};
  });
}
