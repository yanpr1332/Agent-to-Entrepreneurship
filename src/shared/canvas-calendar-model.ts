import { validCivilDay } from "./planning-model";
import type { FixedEvent } from "./fixed-calendar-model";

/** Safe subset of Canvas calendar events. No HTML, location or token is stored. */
export interface CanvasCalendarEvent {
  id:number;
  courseId:number;
  title:string;
  startAt:string|null;
  endAt:string|null;
  allDayDate:string|null;
}
export interface CanvasCalendarSyncResult {
  created:number;
  changed:number;
  missing:number;
  skipped:number;
}
export interface CanvasCalendarFixedEvent extends Omit<FixedEvent,"source"> {
  source:"canvas";
  visible:boolean;
  missing:boolean;
  courseId:number;
  accountId:number;
  instanceOrigin:string;
  remoteId:number;
  lastSyncedAt:string;
  retentionExpiresAt:string|null;
}
export function toLocalCanvasSlot(event:CanvasCalendarEvent):{
  day:string;startMinute:number;durationMinutes:number;
}|null {
  if(event.allDayDate){
    return validCivilDay(event.allDayDate)
      ? {day:event.allDayDate,startMinute:0,durationMinutes:1440}:null;
  }
  if(!event.startAt||!event.endAt)return null;
  const start=new Date(event.startAt),end=new Date(event.endAt);
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
    end.getTime()<=start.getTime())return null;
  const day=[start.getFullYear(),String(start.getMonth()+1).padStart(2,"0"),
    String(start.getDate()).padStart(2,"0")].join("-");
  const startMinute=start.getHours()*60+start.getMinutes();
  const endDay=[end.getFullYear(),String(end.getMonth()+1).padStart(2,"0"),
    String(end.getDate()).padStart(2,"0")].join("-");
  const wallDuration=endDay===day?
    end.getHours()*60+end.getMinutes()-startMinute:
    end.getTime()-start.getTime()<=86400000 &&
      new Date(start.getFullYear(),start.getMonth(),start.getDate()+1).toDateString()===end.toDateString() &&
      end.getHours()===0&&end.getMinutes()===0 ? 1440-startMinute : -1;
  const realDuration=(end.getTime()-start.getTime())/60000;
  // Current planner has civil slots, so reject fractional and DST-changing slots.
  if(!validCivilDay(day)||!Number.isInteger(realDuration)||
    wallDuration<15||wallDuration>1440||wallDuration!==realDuration||
    start.getSeconds()!==0||end.getSeconds()!==0)return null;
  return {day,startMinute,durationMinutes:wallDuration};
}

export type CalendarDisplayEvent=FixedEvent|CanvasCalendarFixedEvent;
