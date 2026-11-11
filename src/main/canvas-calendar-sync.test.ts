import {afterEach,describe,expect,it} from "vitest";
import {CanvasSyncService} from "./connectors/canvas-sync";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {LocalStore} from "./local-store";
import {PlanningStore} from "./planning-store";
import type {CanvasApi} from "./connectors/canvas-api";
import type {CanvasCalendarEvent} from "../shared/canvas-calendar-model";
const origin="https://canvas.example.edu";
const course={id:9,name:"Calculus",courseCode:"MATH"};
const event:CanvasCalendarEvent={
  id:72,courseId:9,title:"Lecture",startAt:"2026-11-12T09:00:00Z",
  endAt:"2026-11-12T10:00:00Z",allDayDate:null,
};
const closeables:Array<{close():void}>=[];
afterEach(()=>{while(closeables.length)closeables.pop()!.close();});
function setup(getEvents:()=>Promise<CanvasCalendarEvent[]>=async()=>[event]){
  const local=new LocalStore(":memory:");closeables.push(local);
  let engine:CanvasSyncService;
  const calendar=new FixedCalendarStore(":memory:",()=>[],()=>engine.scope());
  closeables.push(calendar);
  const api={
    origin,getCurrentUserId:async()=>44,listCourses:async()=>[course],
    listAssignments:async()=>[],listCalendarEvents:async()=>getEvents(),
  } as unknown as CanvasApi;
  engine=new CanvasSyncService(local,async()=>api,()=>{},calendar);
  return {local,calendar,engine};
}
describe("automatic Canvas calendar to offline study planning",()=>{
  it("syncs and exposes course events as busy time, with no duplicate on the next run",async()=>{
    const {calendar,engine}=setup();
    const first=await engine.sync();
    expect(first).toMatchObject({connected:true,calendarCreated:1,calendarFailedCourses:0});
    expect(calendar.listForDisplay().filter(x=>x.source==="canvas")).toHaveLength(1);
    const busy=calendar.busySlots();
    expect(busy).toHaveLength(1);
    const planner=new PlanningStore(":memory:",()=>calendar.busySlots());closeables.push(planner);
    const settings={startDate:busy[0].day,days:1,dailyStart:"00:00",
      dailyEnd:"23:45",minutesPerTask:45};
    const task={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title:"Study",description:"",dueDate:null,priority:"normal" as const,
      completed:false,visible:true,hiddenAt:null,retentionExpiresAt:null,source:null,
      createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z"};
    const proposed=planner.propose(settings,[task],new Date("2026-11-01T00:00:00Z"));
    expect(proposed.blocks.every(b=>!busy.some(c=>
      b.day===c.day&&b.startMinute<c.startMinute+c.durationMinutes&&
      c.startMinute<b.startMinute+b.durationMinutes))).toBe(true);
    expect((await engine.sync()).calendarCreated).toBe(0);
    expect(calendar.listCanvasEvents(origin,44)).toHaveLength(1);
    engine.cancel();
    expect(calendar.listForDisplay()).toHaveLength(0);
    expect(calendar.busySlots()).toEqual([]);
    expect(calendar.listCanvasEvents(origin,44)).toHaveLength(1); // retained, scoped
  });
  it("pauses one course without deleting existing cache",async()=>{
    const {local,calendar,engine}=setup();
    await engine.sync();
    local.setCanvasCourseEnabled(origin,44,9,false);
    await engine.sync();
    expect(calendar.listCanvasEvents(origin,44)).toHaveLength(1);
    expect(calendar.listCanvasEvents(origin,44)[0].missing).toBe(false);
    engine.cancel();
  });
  it("does not write a delayed response after disconnect",async()=>{
    let release:((x:CanvasCalendarEvent[])=>void)|undefined;
    const pending=new Promise<CanvasCalendarEvent[]>(resolve=>{release=resolve;});
    const {calendar,engine}=setup(()=>pending);
    const sync=engine.sync();
    for(let i=0;i<15;i++)await Promise.resolve();
    engine.cancel();
    release?.([event]);
    await sync;
    expect(calendar.listCanvasEvents(origin,44)).toHaveLength(0);
  });
  it("leaves cached events untouched on calendar fetch failure",async()=>{
    let fail=false;
    const {calendar,engine}=setup(async()=>{
      if(fail)throw Error("raw remote internal message");
      return [event];
    });
    await engine.sync();
    fail=true;
    const result=await engine.sync();
    expect(result.calendarFailedCourses).toBe(1);
    expect(result.lastError).not.toContain("raw remote");
    expect(calendar.listCanvasEvents(origin,44)[0].missing).toBe(false);
  });
});
