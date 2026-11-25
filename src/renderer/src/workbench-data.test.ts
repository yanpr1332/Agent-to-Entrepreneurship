import {describe,expect,it} from "vitest";
import {workbenchTaskSummary,workbenchDaySchedule} from "./workbench-data";
import type {LocalTask} from "../../shared/local-model";
import type {PlanBlock} from "../../shared/planning-model";
import type {CalendarDisplayEvent} from "../../shared/canvas-calendar-model";
const day="2026-11-25";
function task(id:string,dueDate:string|null,priority:LocalTask["priority"]="normal"):LocalTask{
  return {id,title:id,description:"private text",dueDate,priority,completed:false,
    createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z",
    source:null,visible:true,hiddenAt:null,retentionExpiresAt:null};
}
describe("workbench shows only true local state, not demo rows",()=>{
  it("orders visible incomplete deadlines, prioritizing same-day important tasks",()=>{
    const rows=[task("undated",null),task("late","2026-11-23"),
      task("today","2026-11-25","normal"),task("urgent","2026-11-25","high"),
      {...task("done","2026-11-25"),completed:true},
      {...task("hidden","2026-11-24"),visible:false},
      task("future","2026-12-01")];
    const result=workbenchTaskSummary(rows,day);
    expect(result).toMatchObject({today:2,overdue:1,pending:5});
    expect(result.preview.map(r=>r.id)).toEqual([
      "late","urgent","today","future","undated"]);
    expect(rows[0].id).toBe("undated"); // selector does not mutate SQLite DTOs
  });
  it("uses confirmed study blocks, excludes removed/hidden Canvas events",()=>{
    const block=(id:string,state:PlanBlock["state"],startMinute:number):PlanBlock=>({
      id,taskId:id,taskTitle:id,taskUpdatedAt:"2026-11-20T00:00:00Z",
      taskDueDate:null,day,startMinute,durationMinutes:60,rationale:"",state,batchId:null,
    });
    const fixed=(id:string,visible:boolean,missing:boolean):CalendarDisplayEvent=>({
      id,day,startMinute:540,durationMinutes:60,title:id,source:"canvas",
      visible,missing,courseId:1,accountId:1,instanceOrigin:"https://canvas.example.edu",
      remoteId:10,lastSyncedAt:"2026-11-25T00:00:00Z",retentionExpiresAt:null,
      // CalendarDisplayEvent includes extra fixed-event properties in actual DTO.
    } as CalendarDisplayEvent);
    const result=workbenchDaySchedule([
      block("tentative","proposed",200),block("confirmed","applied",600)],
      [fixed("normal",true,false),fixed("removed",true,true),
        fixed("hidden",false,false)],day);
    expect(result.count).toBe(2);
    expect(result.planned.map(x=>x.id)).toEqual(["confirmed"]);
    expect(result.fixed.map(x=>x.id)).toEqual(["normal"]);
  });
});
