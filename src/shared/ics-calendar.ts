import {dayOffset,validCivilDay} from "./planning-model";
import {validateFixedTitle,validateFixedSlot,type FixedEvent,type FixedEventDraft,type BusySlot} from "./fixed-calendar-model";

const MAX_ICS_BYTES=512*1024;
const MAX_ICS_EVENTS=250;

function decodeText(value:string):string{
  return value.replace(/\\([nN,;\\])/g,(_,x:string)=>x==="n"||x==="N"?"\n":x);
}
function encodeText(value:string):string{
  return value.replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
}
function localStamp(date:Date):{day:string;minute:number}{
  const day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),
    String(date.getDate()).padStart(2,"0")].join("-");
  return {day,minute:date.getHours()*60+date.getMinutes()};
}
function parseStamp(raw:string,property:string):{day:string;minute:number;allDay:boolean}{
  const key=property.toUpperCase();
  if(key.includes("TZID="))throw Error("ICS TZID time zones are not supported yet; please export UTC or floating time");
  const dateOnly=key==="DTSTART;VALUE=DATE"||key==="DTEND;VALUE=DATE";
  if(dateOnly){
    if(!/^\d{8}$/.test(raw))throw Error("Invalid all-day ICS date");
    const day=raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8);
    if(!validCivilDay(day))throw Error("Invalid all-day ICS date");
    return {day,minute:0,allDay:true};
  }
  if(key!=="DTSTART"&&key!=="DTEND")throw Error("Unsupported ICS date parameters");
  const match=/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(raw);
  if(!match)throw Error("Unsupported ICS datetime format");
  const [,yyyy,mm,dd,hh,mi,ss,z]=match;
  const day=yyyy+"-"+mm+"-"+dd;
  if(!validCivilDay(day)||Number(hh)>23||Number(mi)>59||Number(ss)>59)
    throw Error("Invalid ICS date/time");
  if(z){
    const date=new Date(Date.UTC(Number(yyyy),Number(mm)-1,Number(dd),
      Number(hh),Number(mi),Number(ss)));
    const value=localStamp(date);
    return {...value,allDay:false};
  }
  const date=new Date(Number(yyyy),Number(mm)-1,Number(dd),Number(hh),Number(mi),Number(ss));
  if(date.getFullYear()!==Number(yyyy)||date.getMonth()+1!==Number(mm)||
     date.getDate()!==Number(dd)||date.getHours()!==Number(hh)||
     date.getMinutes()!==Number(mi)||date.getSeconds()!==Number(ss))
     throw Error("ICS floating time is invalid in the device time zone (DST gap)");
  return {day,minute:Number(hh)*60+Number(mi),allDay:false};
}
function getField(fields:Map<string,string>,base:string):[string,string]{
  const matches=[...fields].filter(([k])=>k===base||k.startsWith(base+";"));
  if(matches.length!==1)throw Error("ICS event needs exactly one "+base);
  return matches[0];
}
function parseEvent(fields:Map<string,string>):FixedEventDraft{
  for(const key of fields.keys()){
    const name=key.split(";")[0];
    if(["RRULE","RDATE","EXDATE","RECURRENCE-ID","DURATION"].includes(name))
      throw Error("Recurring ICS rules are not supported in this import. Export expanded occurrences");
  }
  const uid=getField(fields,"UID")[1];
  if(!uid||uid.length>180||/[^\x21-\x7e]/.test(uid))throw Error("Invalid ICS UID");
  const title=validateFixedTitle(decodeText(getField(fields,"SUMMARY")[1]));
  const [sk,sv]=getField(fields,"DTSTART"),[ek,ev]=getField(fields,"DTEND");
  const a=parseStamp(sv,sk),b=parseStamp(ev,ek);
  if(a.allDay!==b.allDay)throw Error("ICS event must use matching DATE/DATE-TIME types");
  let duration:number;
  if(a.allDay){
    if(b.day!==dayOffset(a.day,1))throw Error("Only one-day all-day ICS events are supported");
    duration=1440;
  }else{
    const endsMidnight=b.day===dayOffset(a.day,1)&&b.minute===0;
    if(!endsMidnight&&(a.day!==b.day||b.minute<=a.minute))
      throw Error("Only same-day timed ICS events are supported");
    duration=endsMidnight?1440-a.minute:b.minute-a.minute;
  }
  const slot=validateFixedSlot(a.day,a.minute,duration);
  return {...slot,title,sourceUid:uid};
}
/** All-or-nothing preview. Explicitly reject unsupported recurrence, TZIDs, duplicates or partial data. */
export function parseICS(text:string):FixedEventDraft[]{
  if(typeof text!=="string"||new TextEncoder().encode(text).byteLength>MAX_ICS_BYTES||
     /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw Error("Invalid or oversized ICS file (512 KiB limit)");
  const normalized=text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const lines:string[]=[];
  for(const line of normalized.split("\n")){
    if(/^[ \t]/.test(line) && lines.length)lines[lines.length-1]+=line.slice(1);
    else lines.push(line);
  }
  if(lines.some(line=>line.length>4096))throw Error("ICS property exceeds safety limits");
  if(lines[0]?.trim()!=="BEGIN:VCALENDAR"||!lines.includes("END:VCALENDAR"))
    throw Error("Not a valid ICS VCALENDAR");
  const result:FixedEventDraft[]=[];
  let fields:Map<string,string>|null=null;
  let inTimezone=false;
  let ended=false;
  for(let i=1;i<lines.length;i++){
    const line=lines[i];
    if(!line)continue;
    if(ended)throw Error("Unexpected ICS content after VCALENDAR");
    if(inTimezone){
      if(line==="END:VTIMEZONE")inTimezone=false;
      continue;
    }
    if(line==="BEGIN:VTIMEZONE"&&!fields){inTimezone=true;continue;}
    if(line==="BEGIN:VEVENT"){
      if(fields)throw Error("Nested ICS event");
      fields=new Map();continue;
    }
    if(line==="END:VEVENT"){
      if(!fields)throw Error("Unexpected ICS end event");
      result.push(parseEvent(fields));
      if(result.length>MAX_ICS_EVENTS)throw Error("Too many ICS events (maximum 250)");
      fields=null;continue;
    }
    if(line==="END:VCALENDAR"){
      if(fields||inTimezone)throw Error("Unclosed ICS component");
      ended=true;continue;
    }
    if(line.startsWith("BEGIN:")||line.startsWith("END:"))
      throw Error("ICS component is not supported (VEVENT only)");
    const sep=line.indexOf(":");
    if(sep<1)throw Error("Malformed ICS property");
    if(fields){
      const key=line.slice(0,sep).toUpperCase(),value=line.slice(sep+1);
      if(fields.has(key))throw Error("Duplicate ICS property "+key);
      fields.set(key,value);
    }
  }
  if(!ended||fields||inTimezone||!result.length)throw Error("No valid ICS events");
  if(new Set(result.map(x=>x.sourceUid)).size!==result.length)
    throw Error("Duplicate ICS UID in import file");
  return result;
}
function formatDate(day:string):string{return day.replace(/-/g,"");}
function formatMinute(minute:number):string{
  return String(Math.floor(minute/60)).padStart(2,"0")+
    String(minute%60).padStart(2,"0")+"00";
}
/** Deterministic local floating-time ICS; no remote account data or HTML. */
export function exportICS(events:ReadonlyArray<FixedEvent>):string{
  if(events.length>5000)throw Error("Too many calendar events to export");
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Agent-to-Entrepreneurship//Local Calendar//EN","CALSCALE:GREGORIAN"];
  const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");
  for(const event of events){
    const slot=validateFixedSlot(event.day,event.startMinute,event.durationMinutes);
    lines.push("BEGIN:VEVENT","UID:"+event.id+"@ate.local","DTSTAMP:"+stamp,
      "SUMMARY:"+encodeText(validateFixedTitle(event.title)));
    if(slot.startMinute===0&&slot.durationMinutes===1440){
      lines.push("DTSTART;VALUE=DATE:"+formatDate(slot.day),
        "DTEND;VALUE=DATE:"+formatDate(dayOffset(slot.day,1)));
    }else{
      const end=slot.startMinute+slot.durationMinutes;
      lines.push("DTSTART:"+formatDate(slot.day)+"T"+formatMinute(slot.startMinute),
        "DTEND:"+formatDate(end===1440?dayOffset(slot.day,1):slot.day)+"T"+formatMinute(end===1440?0:end));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const folded:string[]=[];
  for(const line of lines){
    let current="";
    for(const char of line){
      const bytes=new TextEncoder().encode(char).byteLength;
      if(new TextEncoder().encode(current).byteLength+bytes>75){
        folded.push(current);current=" "+char;
      }else current+=char;
    }
    folded.push(current);
  }
  return folded.join("\r\n")+"\r\n";
}
