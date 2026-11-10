import {describe,expect,it} from "vitest";
import {parseICS,exportICS} from "./ics-calendar";
import {resolveIanaTime} from "./ics-timezone";
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
    const folded=wrap(sameDay.replace("Course\\, Lab","Course\\, \r\n Lab"));
    expect(parseICS(folded)[0].title).toBe("Course, Lab");
  });
  it("exports a portable floating-time ICS and imports the exact same slots",()=>{
    const first:FixedEvent={
      id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sourceUid:null,seriesId:null,
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
    expect(()=>parseICS(wrap(evt("1",";TZID=Mars/Olympus:20261111T090000",
      ";TZID=Mars/Olympus:20261111T100000")))).toThrow("IANA");
    expect(()=>parseICS(wrap(evt("1",":20261111T090000",":20261111T100000",
      "RRULE:FREQ=WEEKLY\r\n")))).toThrow("COUNT");
    expect(()=>parseICS(wrap(sameDay+sameDay))).toThrow("Duplicate ICS UID");
    expect(()=>parseICS(wrap(evt("1",":20261111T090000",":20261112T100000"))))
      .toThrow("same-day");
    expect(()=>parseICS(wrap("BEGIN:VTODO\r\nEND:VTODO\r\n"))).toThrow("component");
    expect(()=>parseICS(wrap(sameDay.replace("DTSTART:","DTSTART;VALUE=DATE:")))).toThrow();
  });

  it("expands a finite weekly multi-day recurrence with deterministic series keys",()=>{
    const result=parseICS(wrap(evt("weekly",":20261109T090000",":20261109T100000",
      "RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE\r\n")));
    expect(result.map(x=>x.sourceUid)).toEqual([
      "weekly#20261109","weekly#20261111","weekly#20261116","weekly#20261118",
    ]);
    expect(result.map(x=>x.seriesKey)).toEqual(Array(4).fill("weekly"));
    expect(result.every(x=>x.durationMinutes===60)).toBe(true);
    const biweekly=parseICS(wrap(evt("bi",":20261109T090000",":20261109T100000",
      "RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2\r\n")));
    expect(biweekly.map(x=>x.day)).toEqual(["2026-11-09","2026-11-23","2026-12-07"]);
  });
  it("converts real IANA TZID instants with DST-preserving weekly wall time",()=>{
    const series=parseICS(wrap(evt("pacific",
      ";TZID=America/Los_Angeles:20260302T090000",
      ";TZID=America/Los_Angeles:20260302T100000",
      "RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO\r\n")));
    const stamps=["2026-03-02T17:00:00.000Z","2026-03-09T16:00:00.000Z",
      "2026-03-16T16:00:00.000Z"].map(utc=>new Date(utc));
    expect(series.map(x=>x.startMinute)).toEqual(
      stamps.map(date=>date.getHours()*60+date.getMinutes()));
    expect(series.map(x=>x.day)).toEqual(stamps.map(date=>
      [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),
        String(date.getDate()).padStart(2,"0")].join("-")));
    expect(series.map(x=>x.durationMinutes)).toEqual([60,60,60]);
    expect(resolveIanaTime(2026,11,11,9,0,0,"Asia/Shanghai").toISOString())
      .toBe("2026-11-11T01:00:00.000Z");
  });
  it("rejects DST gaps, fold ambiguity, unbounded/unsupported recurrence and mismatched time bases",()=>{
    expect(()=>resolveIanaTime(2026,3,8,2,30,0,"America/Los_Angeles")).toThrow("daylight");
    expect(()=>resolveIanaTime(2026,11,1,1,30,0,"America/Los_Angeles")).toThrow("daylight");
    expect(()=>parseICS(wrap(evt("gap",";TZID=America/Los_Angeles:20260308T023000",
      ";TZID=America/Los_Angeles:20260308T033000")))).toThrow("daylight");
    expect(()=>parseICS(wrap(evt("bad",":20261109T090000",":20261109T100000",
      "RRULE:FREQ=MONTHLY;COUNT=3\r\n"))).toThrow("Unsupported");
    expect(()=>parseICS(wrap(evt("until",":20261109T090000",":20261109T100000",
      "RRULE:FREQ=WEEKLY;UNTIL=20270101T000000Z\r\n"))).toThrow("Unsupported");
    expect(()=>parseICS(wrap(evt("long",":20261109T090000",":20261109T100000",
      "RRULE:FREQ=WEEKLY;COUNT=250;INTERVAL=8\r\n"))).toThrow("two-year");
    expect(()=>parseICS(wrap(evt("mismatch",":20261109T090000Z",":20261109T100000")))
      ).toThrow("same time basis");
  });
  it("refuses invalid civil dates, DST impossible local times and oversized files",()=>{
    expect(()=>parseICS(wrap(evt("1",":20260230T090000",":20260230T100000")))).toThrow();
    expect(()=>parseICS("A".repeat(512*1024+1))).toThrow("512 KiB");
    expect(()=>parseICS(wrap(sameDay.replace("SUMMARY:Course","SUMMARY:\x00Course")))).toThrow();
  });
});
