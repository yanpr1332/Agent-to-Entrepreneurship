import type {LocalTask} from "./local-model";
import type {PlanBlock} from "./planning-model";
import type {CalendarDisplayEvent} from "./canvas-calendar-model";

/** Pure view selectors. Dates are device-local YYYY-MM-DD keys (no UTC
 * conversion, no hidden/retained Canvas items, no inferred completion). */
export function workbenchTaskSummary(tasks:readonly LocalTask[],today:string){
  const pending=tasks.filter(task=>task.visible&&!task.completed);
  const dueToday=pending.filter(task=>task.dueDate===today);
  const overdue=pending.filter(task=>task.dueDate!==null&&task.dueDate<today);
  const upcoming=[...pending].sort((a,b)=>{
    const d=(a.dueDate??"9999-12-31").localeCompare(b.dueDate??"9999-12-31");
    if(d)return d;
    const priority={high:0,normal:1,low:2};
    const p=priority[a.priority]-priority[b.priority];
    return p||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
  });
  return {today:dueToday.length,overdue:overdue.length,pending:pending.length,
    preview:upcoming.slice(0,5)};
}
export function workbenchDaySchedule(
  blocks:readonly PlanBlock[],events:readonly CalendarDisplayEvent[],day:string){
  const planned=blocks.filter(b=>b.day===day&&b.state==="applied")
    .slice().sort((a,b)=>a.startMinute-b.startMinute||a.id.localeCompare(b.id));
  const fixed=events.filter(e=>e.day===day&&
    (e.source!=="canvas"||(e.visible&&!e.missing)))
    .slice().sort((a,b)=>a.startMinute-b.startMinute||a.id.localeCompare(b.id));
  return {planned:planned.slice(0,5),fixed:fixed.slice(0,5),
    count:planned.length+fixed.length};
}
