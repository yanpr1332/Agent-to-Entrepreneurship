import type { LocalTask } from "./local-model";

export interface PlanningSettings {
  startDate: string;
  days: number;
  dailyStart: string;
  dailyEnd: string;
  minutesPerTask: number;
}
export interface PlanBlock {
  id: string;
  taskId: string;
  taskTitle: string;
  taskUpdatedAt: string;
  taskDueDate: string | null;
  day: string;
  startMinute: number;
  durationMinutes: number;
  rationale: string;
  state: "proposed" | "applied";
  batchId: string | null;
}
export interface PlanProposal {
  id: string;
  createdAt: string;
  settings: PlanningSettings;
  blocks: PlanBlock[];
  skipped: { taskId: string; reason: string }[];
}
export interface AppliedPlanBatch {
  id: string;
  appliedAt: string;
  blocks: PlanBlock[];
}
export interface PlanEdit {
  blockId: string;
  day: string;
  startMinute: number;
}
export interface ApplyPlanRequest {
  proposalId: string;
  blockIds: string[];
  edits: PlanEdit[];
}

export function validCivilDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(value+"T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value;
}
export function dayOffset(day:string, offset:number):string {
  const date=new Date(day+"T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate()+offset);
  return date.toISOString().slice(0,10);
}
export function minuteString(minutes:number):string {
  return String(Math.floor(minutes/60)).padStart(2,"0")+":"+
    String(minutes%60).padStart(2,"0");
}
export function parseMinute(value:unknown):number {
  if(typeof value!=="string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw Error("Invalid planning clock time");
  const [hours,mins]=value.split(":").map(Number);
  return hours*60+mins;
}
export function parsePlanningSettings(raw:unknown):PlanningSettings {
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw Error("Invalid planning settings");
  const s=raw as Record<string,unknown>;
  if(Object.keys(s).sort().join(",")!=="dailyEnd,dailyStart,days,minutesPerTask,startDate" ||
     !validCivilDay(s.startDate) ||
     !Number.isSafeInteger(s.days) || (s.days as number)<1 || (s.days as number)>21 ||
     !Number.isSafeInteger(s.minutesPerTask) || (s.minutesPerTask as number)<15 ||
     (s.minutesPerTask as number)>120 || (s.minutesPerTask as number)%15!==0) {
    throw Error("Invalid planning settings");
  }
  const start=parseMinute(s.dailyStart),end=parseMinute(s.dailyEnd);
  if(end-start<30 || end>24*60 || start<6*60 || end-start>8*60)
    throw Error("Choose a daily window between 06:00 and 23:59, 30–480 minutes");
  return {
    startDate:s.startDate as string,days:s.days as number,dailyStart:s.dailyStart as string,
    dailyEnd:s.dailyEnd as string,minutesPerTask:s.minutesPerTask as number,
  };
}
export function parsePlanApply(value:unknown):ApplyPlanRequest {
  if(!value || typeof value!=="object" || Array.isArray(value))
    throw Error("Invalid plan selection");
  const x=value as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="blockIds,edits,proposalId" ||
     typeof x.proposalId!=="string" || !/^[0-9a-f-]{36}$/i.test(x.proposalId) ||
     !Array.isArray(x.blockIds) || x.blockIds.length<1 || x.blockIds.length>64 ||
     !x.blockIds.every(id=>typeof id==="string" && /^[0-9a-f-]{36}$/i.test(id)) ||
     new Set(x.blockIds).size!==x.blockIds.length ||
     !Array.isArray(x.edits) || x.edits.length>64)throw Error("Invalid plan selection");
  const edits=x.edits.map(edit=>{
    if(!edit || typeof edit!=="object" || Array.isArray(edit))
      throw Error("Invalid plan edit");
    const e=edit as Record<string,unknown>;
    if(Object.keys(e).sort().join(",")!=="blockId,day,startMinute" ||
       typeof e.blockId!=="string" || !(x.blockIds as string[]).includes(e.blockId) ||
       !validCivilDay(e.day) ||
       !Number.isSafeInteger(e.startMinute) || (e.startMinute as number)<0 ||
       (e.startMinute as number)>1439 || (e.startMinute as number)%15!==0)
       throw Error("Invalid plan edit");
    return {blockId:e.blockId,day:e.day as string,startMinute:e.startMinute as number};
  });
  if(new Set(edits.map(e=>e.blockId)).size!==edits.length)throw Error("Duplicate plan edit");
  return {proposalId:x.proposalId,blockIds:x.blockIds as string[],edits};
}

/** Derived for a preview only: no model, cloud access, or writes to local tasks. */
export function eligiblePlanningTasks(tasks:LocalTask[]):LocalTask[] {
  return tasks.filter(t=>t.visible && !t.completed).sort((a,b)=>{
    const due=(a.dueDate??"9999-12-31").localeCompare(b.dueDate??"9999-12-31");
    if(due!==0)return due;
    const priority={high:0,normal:1,low:2};
    return priority[a.priority]-priority[b.priority] || a.createdAt.localeCompare(b.createdAt);
  });
}
