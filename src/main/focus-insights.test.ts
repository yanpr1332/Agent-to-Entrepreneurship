import {describe,it,expect,afterEach} from "vitest";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildFocusInsights,requireFocusTimeZone,type FocusInsightRow} from "./focus-insights";
import {LocalStore} from "./local-store";
const row=(ended_at:string,elapsed_seconds=60,completed=1,
  time_source="recorded"):FocusInsightRow=>({
  ended_at,elapsed_seconds,completed,points:completed?Math.floor(elapsed_seconds/60):0,
  time_source,
});
const roots:string[]=[];
const stores:LocalStore[]=[];
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  while(roots.length)rmSync(roots.pop()!,{force:true,recursive:true});
});
describe("FOC-005 local calendar date summaries",()=>{
  it("assigns sessions to their end-date in a user IANA zone rather than UTC",()=>{
    const now=new Date("2026-11-25T04:00:00.000Z");
    const report=buildFocusInsights([
      row("2026-11-24T15:30:00.000Z",45),
      row("2026-11-24T16:30:00.000Z",45),
    ],"Asia/Shanghai",now);
    expect(report.days.slice(-2).map(x=>[x.day,x.sessions,x.minutes]))
      .toEqual([["2026-11-24",1,0],["2026-11-25",1,0]]);
    // Aggregate seconds before minute flooring; never truncate each session.
    expect(report.last7).toMatchObject({sessions:2,minutes:1,completedSessions:2});
    expect(report.currentStreakDays).toBe(2);
    expect(report.days).toHaveLength(30);
    expect(report.timeZone).toBe("Asia/Shanghai");
  });

  it("groups daylight-saving spring-forward dates accurately in Los Angeles",()=>{
    const now=new Date("2026-03-10T18:00:00.000Z");
    const result=buildFocusInsights([
      row("2026-03-08T07:30:00.000Z",180),
      row("2026-03-08T09:30:00.000Z",120),
      row("2026-03-09T06:30:00.000Z",60),
    ],"America/Los_Angeles",now);
    const march7=result.days.find(x=>x.day==="2026-03-07");
    const march8=result.days.find(x=>x.day==="2026-03-08");
    expect(march7).toMatchObject({sessions:1,minutes:3});
    expect(march8).toMatchObject({sessions:2,minutes:3});
    expect(result.last7.minutes).toBe(6);
    expect(result.currentStreakDays).toBe(0);
    expect(result.bestStreakDays).toBe(2);
  });

  it("keeps a streak through yesterday until today ends, without awarding it for partial work",()=>{
    const now=new Date("2026-11-25T12:00:00.000Z");
    const base=[
      row("2026-11-22T12:00:00.000Z"),
      row("2026-11-23T12:00:00.000Z"),
      row("2026-11-24T12:00:00.000Z"),
      row("2026-11-25T09:00:00.000Z",70,0),
    ];
    const report=buildFocusInsights(base,"UTC",now);
    expect(report.currentStreakDays).toBe(3);
    expect(report.last7).toMatchObject({sessions:4,completedSessions:3});
    expect(buildFocusInsights([...base,
      row("2026-11-25T10:00:00.000Z")],"UTC",now).currentStreakDays).toBe(4);
    expect(buildFocusInsights([
      row("2026-11-23T12:00:00.000Z")],"UTC",now).currentStreakDays).toBe(0);
  });

  it("tracks estimated legacy sessions without claiming measured wall time",()=>{
    const r=buildFocusInsights([
      row("2026-11-25T10:00:00.000Z",90,1,"estimated"),
      row("2026-11-25T11:00:00.000Z",30,0),
    ],"UTC",new Date("2026-11-25T12:00:00.000Z"));
    expect(r.last30.minutes).toBe(2);
    expect(r.estimatedSessions).toBe(1);
    expect(r.days[29]).toMatchObject({estimatedSessions:1,recordedSessions:1});
  });

  it("excludes outdated history and distinguishes the preceding week",()=>{
    const now=new Date("2026-11-25T12:00:00.000Z");
    const r=buildFocusInsights([
      row("2026-10-20T12:00:00.000Z",1200),
      row("2026-11-15T12:00:00.000Z",120),
      row("2026-11-25T11:00:00.000Z",180),
    ],"UTC",now);
    expect(r.last30).toMatchObject({sessions:2,minutes:5});
    expect(r.previous7).toMatchObject({sessions:1,minutes:2});
    expect(r.last7).toMatchObject({sessions:1,minutes:3});
  });

  it("rejects invalid timezone, impossible timestamps and corrupt points",()=>{
    for(const v of ["","Unknown/Zone","UTC; DROP TABLE focus_sessions","A".repeat(200),42]){
      expect(()=>requireFocusTimeZone(v)).toThrow();
    }
    const now=new Date("2026-11-25T12:00:00.000Z");
    expect(()=>buildFocusInsights([row("2026-11-26T00:00:00.000Z")],"UTC",now))
      .toThrow("Invalid stored");
    expect(()=>buildFocusInsights([
      {...row("2026-11-25T09:00:00.000Z"),points:-1},
    ],"UTC",now)).toThrow("Invalid stored");
  });

  it("queries the entire bounded SQLite window rather than the last-500 history list",()=>{
    const root=mkdtempSync(join(tmpdir(),"sa-focus-insights-"));roots.push(root);
    const file=join(root,"data.sqlite");
    const store=new LocalStore(file);stores.push(store);
    const sql=new DatabaseSync(file);
    const end=new Date(Date.now()-3600000).toISOString();
    const start=new Date(Date.now()-3660000).toISOString();
    sql.exec("BEGIN IMMEDIATE");
    const insert=sql.prepare(
      "INSERT INTO focus_sessions "+
      "(id,title,planned_minutes,elapsed_seconds,completed,points,"+
      "started_at,ended_at,time_source) VALUES(?,?,?,?,?,?,?,?,?)"
    );
    for(let i=0;i<520;i++){
      insert.run(randomUUID(),"Synthetic offline test",1,60,1,1,start,end,"recorded");
    }
    sql.exec("COMMIT");sql.close();
    expect(store.listFocusSessions()).toHaveLength(500);
    const today=store.focusInsights("UTC");
    expect(today.last7).toMatchObject({sessions:520,completedSessions:520,
      minutes:520,points:520});
    expect(today.days.reduce((sum,d)=>sum+d.sessions,0)).toBe(520);
    expect(()=>store.focusInsights("/tmp/private")).toThrow("timezone");
  });
});
