import {describe,expect,it} from "vitest";
import {parseICS,exportICS} from "./ics-calendar";
import type {FixedEvent} from "./fixed-calendar-model";

const wrap=(body:string)=>"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"+body+"END:VCALENDAR\r\n";
const evt=(uid:string,start:string,end:string,extra="")=>
  "BEGIN:VEVENT\r\nUID:"+uid+"\r\nSUMMARY:Course\\, Lab\r\n"+
  "DTSTART"+start+"\r\nDTEND"+end+"\r\n"+extra+"END:VEVENT\r\n";
const sameDay=evt("course-1",":20261111T090000",":20261111T100000");
describe("strict opt-in local ICS support",()=>{
  it("parses floating events, escaped text, folded lines and all-day events",()=>{
    const ics=wrap(sameDay+evt("all-day",";VALUE=DATE:20261112",";VALUE=DATE:20261113"));
    expect(parseICS(ics)).toMatchObject([
      {sourceUid:"course-1",title:"Course, Lab",day:"2026-11-11",startMinute:540,durationMinutes:60},
      {sourceUid:"all-day",day:"2026-11-12",startMinute:0,durationMinutes:1440},
    ]);
    const folded=wrap(sameDay.replace("Course\\, Lab","Course\\,\r\n Lab"));
    expect(parseICS(folded)[0].title).toBe("Course, Lab");
  });
  it("exports a portable floating-time ICS and imports the exact same slots",()=>{
    const first:FixedEvent={
      id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sourceUid:null,
      title:"课程;Physics, Week 1",day:"2026-11-11",startMinute:540,durationMinutes:60,
      source:"manual",createdAt:"2026-11-10T00:00:00Z",
    };
    const midnight:FixedEvent={...first,id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title:"Late lab",startMinute:1410,durationMinutes:30};
    const allDay:FixedEvent={...first,id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      title:"Field trip",startMinute:0,durationMinutes:1440};
    const result=exportICS([first,midnight,allDay]);
    expect(result).toContain("\r\n");
    expect(parseICS(result)).toMatchObject([
      {title:first.title,day:first.day,startMinute:540,durationMinutes:60},
      {title:"Late lab",day:first.day,startMinute:1410,durationMinutes:30},
      {title:"Field trip",day:first.day,startMinute:0,durationMinutes:1440},
    ]);
  });
  it("rejects recurring/TZID/multi-day, duplicate UIDs and unsupported contents without partial import",()=>{
    expect(()=>parseICS(wrap(evt("1",";TZID=Asia/Shanghai:20261111T090000",
      ";TZID=Asia/Shanghai:20261111T100000")))).toThrow("TZID");
    expect(()=>parseICS(wrap(evt("1",":20261111T090000",":20261111T100000",
      "RRULE:FREQ=WEEKLY\r\n")))).toThrow("Recurring");
    expect(()=>parseICS(wrap(sameDay+sameDay))).toThrow("Duplicate ICS UID");
    expect(()=>parseICS(wrap(evt("1",":20261111T090000",":20261112T100000"))))
      .toThrow("same-day");
    expect(()=>parseICS(wrap("BEGIN:VTODO\r\nEND:VTODO\r\n"))).toThrow("component");
    expect(()=>parseICS(wrap(sameDay.replace("DTSTART:","DTSTART;VALUE=DATE:")))).toThrow();
  });
  it("refuses invalid civil dates, DST impossible local times and oversized files",()=>{
    expect(()=>parseICS(wrap(evt("1",":20260230T090000",":20260230T100000")))).toThrow();
    expect(()=>parseICS("A".repeat(512*1024+1))).toThrow("512 KiB");
    expect(()=>parseICS(wrap(sameDay.replace("SUMMARY:Course","SUMMARY:\x00Course")))).toThrow();
  });
});
