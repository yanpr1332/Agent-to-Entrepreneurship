import type {LocalTask} from "../../shared/local-model";
import type {CalendarDisplayEvent} from "../../shared/canvas-calendar-model";
import {minuteString,type PlanBlock} from "../../shared/planning-model";
import {formatDueDate} from "./calendar";
import {buildCalendarAgenda,calendarWeekDays,type CalendarView} from "./calendar-agenda";

const weekday = ["日","一","二","三","四","五","六"];
function dayName(day:string):string {
  const [y,m,d]=day.split("-").map(Number);
  return "周"+weekday[new Date(y,m-1,d,12).getDay()];
}
function clock(start:number,duration:number):string{
  if(start===0&&duration===1440)return "全天";
  return minuteString(start)+"–"+minuteString(start+duration);
}

export default function CalendarAgenda({
  view,selectedDay,today,tasks,blocks,events,onSelectDate,onEditTask,
}:{
  view:Extract<CalendarView,"day"|"week">;
  selectedDay:string;
  today:string;
  tasks:readonly LocalTask[];
  blocks:readonly PlanBlock[];
  events:readonly CalendarDisplayEvent[];
  onSelectDate:(day:string)=>void;
  onEditTask:(task:LocalTask)=>void;
}){
  const dates=view==="day"?[selectedDay]:calendarWeekDays(selectedDay);
  const days=buildCalendarAgenda(dates,tasks,blocks,events);
  const conflictCount=days.reduce((sum,day)=>sum+
    day.timed.filter(e=>e.conflict).length,0);
  return <div className={view==="week"?"agenda-week":"agenda-day"} aria-label={view==="week"?"每周日程":"每日时间线"}>
    <div className="agenda-legend" aria-label="日程图例">
      <span><i className="agenda-key agenda-fixed"/>固定课程 / ICS</span>
      <span><i className="agenda-key agenda-canvas"/>Canvas 课程</span>
      <span><i className="agenda-key agenda-study"/>已确认学习时间</span>
      <span><i className="agenda-key agenda-deadline"/>任务截止日（不占用时间）</span>
    </div>
    {conflictCount>0&&<p className="retention-warning" role="status">
      当前视图有 {conflictCount} 个日程条目涉及时间重叠。请核对固定课程和学习时间；
      本视图不会自动调整或删除已确认的计划。
    </p>}
    <div className={view==="week"?"agenda-week-grid":"agenda-day-grid"}>
      {days.map(day=>{
        const count=day.timed.length+day.deadlines.length;
        return <section key={day.day}
          className={"agenda-date"+(day.day===selectedDay?" agenda-selected":"")}>
          <button type="button" className="agenda-date-head"
            aria-current={day.day===today?"date":undefined}
            aria-pressed={day.day===selectedDay}
            onClick={()=>onSelectDate(day.day)}
            title={"选择 "+formatDueDate(day.day)}>
            <span>{dayName(day.day)} · {day.day.slice(5)}</span>
            <small>{count} 项 {day.day===today?"· 今天":""}</small>
          </button>
          {day.timed.length===0&&day.deadlines.length===0?
            <p className="agenda-empty">无日程</p>:
            <div className="agenda-date-body">
              {day.timed.length>0&&<ol className="agenda-events">
                {day.timed.map(entry=><li key={entry.kind+":"+entry.id}
                  className={"agenda-entry agenda-"+entry.kind+(entry.conflict?" agenda-conflict":"")}>
                  <span className="agenda-clock">{clock(entry.startMinute,entry.durationMinutes)}</span>
                  <strong>{entry.title}</strong>
                  <small>{entry.kind==="study"?"学习计划":entry.kind==="canvas"?"Canvas":"固定事项"}
                    {entry.conflict?" · 时间重叠":""}</small>
                </li>)}
              </ol>}
              {day.deadlines.length>0&&<div className="agenda-deadlines">
                <small>截止任务 · {day.deadlines.length}</small>
                <ul>{day.deadlines.map(task=><li key={task.id}>
                  <button className="agenda-task-link" onClick={()=>onEditTask(task)}
                    aria-label={"编辑截止任务 "+task.title}>
                    <span className={task.completed?"agenda-task-done":undefined}>{task.title}</span>
                    {task.completed&&<small>已完成</small>}
                    {!task.completed&&task.priority==="high"&&<small>高优先级</small>}
                  </button>
                </li>)}</ul>
              </div>}
            </div>}
        </section>;
      })}
    </div>
    <p className="privacy-note">截止日期不是有具体时刻的日历事件。隐藏或已从 Canvas 消失的事项不会在时间线中显示，也不占用规划时间。周视图点选日期可更新下方任务和课程编辑区。</p>
  </div>;
}
