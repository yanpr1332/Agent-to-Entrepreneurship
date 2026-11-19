import type {FocusSession,LocalTask} from "../../shared/local-model";
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
  view,selectedDay,today,tasks,blocks,events,sessions,onSelectDate,onEditTask,
}:{
  view:Extract<CalendarView,"day"|"week">;
  selectedDay:string;
  today:string;
  tasks:readonly LocalTask[];
  blocks:readonly PlanBlock[];
  events:readonly CalendarDisplayEvent[];
  sessions:readonly FocusSession[];
  onSelectDate:(day:string)=>void;
  onEditTask:(task:LocalTask)=>void;
}){
  const dates=view==="day"?[selectedDay]:calendarWeekDays(selectedDay);
  const days=buildCalendarAgenda(dates,tasks,blocks,events,sessions);
  const conflictCount=days.reduce((sum,day)=>sum+
    day.timed.filter(e=>e.conflict).length,0);
  return <div className={view==="week"?"agenda-week":"agenda-day"} aria-label={view==="week"?"每周日程":"每日时间线"}>
    <div className="agenda-legend" aria-label="日程图例">
      <span><i className="agenda-key agenda-fixed"/>固定课程 / ICS</span>
      <span><i className="agenda-key agenda-canvas"/>Canvas 课程</span>
      <span><i className="agenda-key agenda-study"/>已确认学习时间</span>
      <span><i className="agenda-key agenda-focus"/>实际专注记录</span>
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
                  <small>{entry.kind==="focus"
                    ? `实际专注 · 整段有效 ${Math.floor((entry.effectiveFocusSeconds ?? 0)/60)} 分钟${entry.focusCompleted?" · 完成":" · 提前结束"}`
                    : entry.kind==="study"?"学习计划":entry.kind==="canvas"?"Canvas":"固定事项"}
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
    <p className="privacy-note">实际专注是设备记录的起止区间，可能包含暂停；有效专注分钟数另行统计，不与学习计划混为一谈。历史估算时间不显示为真实日历时段。任务截止日期不占用时间，隐藏的 Canvas 事项不会占用规划时间。</p>
  </div>;
}
