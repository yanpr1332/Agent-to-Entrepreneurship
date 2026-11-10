import {dayOffset,validCivilDay} from "./planning-model";
import {resolveIanaTime} from "./ics-timezone";
import {validateFixedTitle,validateFixedSlot,type FixedEvent,type FixedEventDraft} from "./fixed-calendar-model";

const MAX_ICS_BYTES=512*1024;
const MAX_ICS_EVENTS=250;

function decodeText(value:string):string{
  return value.replace(/\\([nN,;\\])/g,(_,x:string)=>x==="n"||x==="N"?"\n":x);
}
function encodeText(value:string):string{
  return value.replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");
}
function localStamp(date:Date):{day:string;minute:number}{
  // Civil-day-only storage cannot distinguish the two occurrences of a fall-back clock hour.
  const deviceZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const resolved=resolveIanaTime(date.getFullYear(),date.getMonth()+1,date.getDate(),
    date.getHours(),date.getMinutes(),date.getSeconds(),deviceZone);
  if(resolved.getTime()!==date.getTime())throw Error("Ambiguous device-local ICS time");
  const day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),
    String(date.getDate()).padStart(2,"0")].join("-");
  return {day,minute:date.getHours()*60+date.getMinutes()};
}
function parseStamp(raw:string,property:string):{day:string;minute:number;allDay:boolean;instant:number|null}{
  const key=property.toUpperCase();
  const zone=/;TZID=([^;]+)$/i.exec(property)?.[1];
  const dateOnly=key==="DTSTART;VALUE=DATE"||key==="DTEND;VALUE=DATE";
  if(dateOnly){
    if(!/^\d{8}$/.test(raw))throw Error("Invalid all-day ICS date");
    const day=raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8);
    if(!validCivilDay(day))throw Error("Invalid all-day ICS date");
    return {day,minute:0,allDay:true,instant:null};
  }
  if(!/^(?:DTSTART|DTEND)(?:;TZID=[A-Za-z0-9_+./-]+)?$/i.test(property))
    throw Error("Unsupported ICS date parameters");
  const match=/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(raw);
  if(!match)throw Error("Unsupported ICS datetime format");
  const [,yyyy,mm,dd,hh,mi,ss,z]=match;
  const day=yyyy+"-"+mm+"-"+dd;
  if(!validCivilDay(day)||Number(hh)>23||Number(mi)>59||Number(ss)!==0)
    throw Error("Invalid ICS date/time");
  if(zone){
    if(z)throw Error("ICS TZID must not include a UTC suffix");
    const date=resolveIanaTime(Number(yyyy),Number(mm),Number(dd),Number(hh),Number(mi),0,zone);
    return {...localStamp(date),allDay:false,instant:date.getTime()};
  }
  if(z){
    const date=new Date(Date.UTC(Number(yyyy),Number(mm)-1,Number(dd),
      Number(hh),Number(mi),Number(ss)));
    const value=localStamp(date);
    return {...value,allDay:false,instant:date.getTime()};
  }
  const date=resolveIanaTime(Number(yyyy),Number(mm),Number(dd),Number(hh),
    Number(mi),0,Intl.DateTimeFormat().resolvedOptions().timeZone);
  return {day,minute:Number(hh)*60+Number(mi),allDay:false,instant:date.getTime()};
}
function getField(fields:Map<string,string>,base:string):[string,string]{
  const matches=[...fields].filter(([k])=>k===base||k.startsWith(base+";"));
  if(matches.length!==1)throw Error("ICS event needs exactly one "+base);
  return matches[0];
}
function makeSlot(uid:string,title:string,sk:string,sv:string,ek:string,ev:string):FixedEventDraft{
  const a=parseStamp(sv,sk),b=parseStamp(ev,ek);
  if(a.allDay!==b.allDay)throw Error("ICS event must use matching DATE/DATE-TIME types");
  const startKind=a.allDay?"date":/;TZID=/i.test(sk)?"zone:"+sk.split("=").at(-1):
    sv.endsWith("Z")?"utc":"floating";
  const endKind=b.allDay?"date":/;TZID=/i.test(ek)?"zone:"+ek.split("=").at(-1):
    ev.endsWith("Z")?"utc":"floating";
  if(startKind!==endKind)throw Error("ICS DTSTART and DTEND must use the same time basis");
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
  if(a.instant!==null&&b.instant!==null && (b.instant-a.instant)!==duration*60_000)
    throw Error("ICS event crosses a daylight saving transition and cannot fit a civil time slot");
  const slot=validateFixedSlot(a.day,a.minute,duration);
  return {...slot,title,sourceUid:uid};
}
const weekdays:Record<string,number>={SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
function shiftRawDate(raw:string,day:string):string{
  if(/^\d{8}$/.test(raw))return day.replace(/-/g,"");
  return day.replace(/-/g,"")+raw.slice(8);
}
function rawDay(raw:string):string{
  const day=raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8);
  if(!validCivilDay(day))throw Error("Invalid ICS recurrence start day");
  return day;
}
function parseEvent(fields:Map<string,string>):FixedEventDraft[]{
  for(const key of fields.keys()){
    const name=key.split(";")[0];
    if(["RDATE","EXDATE","RECURRENCE-ID","DURATION"].includes(name))
      throw Error("Unsupported ICS recurrence exception or duration");
  }
  const uid=getField(fields,"UID")[1];
  if(!uid||uid.length>180||/[^\x21-\x7e]/.test(uid))throw Error("Invalid ICS UID");
  const title=validateFixedTitle(decodeText(getField(fields,"SUMMARY")[1]));
  const [sk,sv]=getField(fields,"DTSTART"),[ek,ev]=getField(fields,"DTEND");
  const first=makeSlot(uid,title,sk,sv,ek,ev);
  const recurrence=fields.get("RRULE");
  if(!recurrence)return [first];
  // Explicit, finite weekly recurrence only. Anything else fails the whole import.
  if(uid.length>168)throw Error("Recurring ICS UID is too long");
  const fieldsRule=recurrence.toUpperCase().split(";");
  const rule=new Map<string,string>();
  for(const part of fieldsRule){
    const kv=/^([A-Z]+)=([A-Z0-9,]+)$/.exec(part);
    if(!kv||rule.has(kv[1]))throw Error("Unsupported ICS recurrence rule");
    rule.set(kv[1],kv[2]);
  }
  if([...rule.keys()].some(key=>!["FREQ","COUNT","INTERVAL","BYDAY"].includes(key))||
    rule.get("FREQ")!=="WEEKLY")throw Error("Unsupported ICS recurrence rule");
  const count=Number(rule.get("COUNT")),interval=Number(rule.get("INTERVAL")??"1");
  if(!Number.isSafeInteger(count)||count<1||count>250||
    !Number.isSafeInteger(interval)||interval<1||interval>8)
    throw Error("ICS weekly recurrence requires COUNT (1–250), interval 1–8");
  const initial=rawDay(sv),endOrigin=rawDay(ev);
  const originalWeekday=new Date(initial+"T00:00:00Z").getUTCDay();
  const days=(rule.get("BYDAY")??Object.keys(weekdays).find(x=>weekdays[x]===originalWeekday)!).
    split(",");
  if(new Set(days).size!==days.length||days.some(d=>!(d in weekdays))||
    !days.some(d=>weekdays[d]===originalWeekday))throw Error("Invalid ICS BYDAY for DTSTART");
  const eventDays=new Set(days.map(d=>weekdays[d]));
  const startWeekOffset=(originalWeekday+6)%7; // ISO Monday week anchor.
  const rawEndOffset=Math.round((Date.parse(endOrigin+"T00:00:00Z")-
    Date.parse(initial+"T00:00:00Z"))/86400000);
  const output:FixedEventDraft[]=[];
  for(let delta=0;delta<=730&&output.length<count;delta++){
    const date=dayOffset(initial,delta),weekday=new Date(date+"T00:00:00Z").getUTCDay();
    if(Math.floor((delta+startWeekOffset)/7)%interval!==0||!eventDays.has(weekday))continue;
    const futureEnd=dayOffset(date,rawEndOffset);
    const sourceUid=uid+"#"+date.replace(/-/g,"");
    const next=makeSlot(sourceUid,title,sk,shiftRawDate(sv,date),
      ek,shiftRawDate(ev,futureEnd));
    output.push({...next,seriesKey:uid});
  }
  if(output.length!==count)throw Error("ICS recurring series exceeds a two-year import window");
  return output;
}

/** All-or-nothing preview. Only finite weekly COUNT recurrence and IANA zones are supported. */
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
      result.push(...parseEvent(fields));
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
      const key=line.slice(0,sep).replace(/^[^;]+/,name=>name.toUpperCase()),value=line.slice(sep+1);
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
