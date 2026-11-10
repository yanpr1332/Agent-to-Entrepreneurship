import { dayOffset,validCivilDay } from "./planning-model";

export interface FixedEvent {
  id:string;
  sourceUid:string|null;
  title:string;
  day:string;
  startMinute:number;
  durationMinutes:number;
  source:"manual"|"ics";
  createdAt:string;
}
export type FixedEventDraft=Pick<FixedEvent,"title"|"day"|"startMinute"|"durationMinutes"> & {sourceUid:string|null};
export interface CreateFixedEventInput {
  title:string;
  day:string;
  startMinute:number;
  durationMinutes:number;
  weeks:number;
}
export interface BusySlot {day:string;startMinute:number;durationMinutes:number}
export interface ICSPreview {
  approvalId:string;
  expiresAt:string;
  filename:string;
  events:FixedEventDraft[];
}
export interface ICSImportResult {added:number;alreadyPresent:number}
export interface ICSExportResult {saved:boolean;eventCount:number}

export function validateFixedTitle(title:unknown):string{
  if(typeof title!=="string"||!title.trim()||title.length>120||
     /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title))
    throw Error("Calendar title must contain 1–120 safe characters");
  return title.trim();
}
export function validateFixedSlot(day:unknown,startMinute:unknown,durationMinutes:unknown):BusySlot{
  if(!validCivilDay(day)||!Number.isSafeInteger(startMinute)||!Number.isSafeInteger(durationMinutes)||
     (startMinute as number)<0||(startMinute as number)>=1440||
     (durationMinutes as number)<15||(durationMinutes as number)>1440||
     (startMinute as number)+(durationMinutes as number)>1440)
    throw Error("Calendar event must fit inside one valid local day");
  return {day,startMinute:startMinute as number,durationMinutes:durationMinutes as number};
}
export function parseCreateFixedEvent(input:unknown):CreateFixedEventInput{
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Invalid fixed event");
  const x=input as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="day,durationMinutes,startMinute,title,weeks"||
     !Number.isSafeInteger(x.weeks)||(x.weeks as number)<1||(x.weeks as number)>16)
    throw Error("Invalid fixed event repetition (1–16 weeks)");
  const slot=validateFixedSlot(x.day,x.startMinute,x.durationMinutes);
  return {title:validateFixedTitle(x.title),...slot,weeks:x.weeks as number};
}
export function weeklyOccurrences(input:CreateFixedEventInput):FixedEventDraft[]{
  return Array.from({length:input.weeks},(_,i)=>({
    title:input.title,day:dayOffset(input.day,i*7),
    startMinute:input.startMinute,durationMinutes:input.durationMinutes,sourceUid:null,
  }));
}
export function timesOverlap(a:BusySlot,b:BusySlot):boolean {
  return a.day===b.day&&a.startMinute<b.startMinute+b.durationMinutes&&
    b.startMinute<a.startMinute+a.durationMinutes;
}
