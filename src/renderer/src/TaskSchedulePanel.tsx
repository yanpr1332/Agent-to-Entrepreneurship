import { useEffect, useState, type FormEvent } from "react";
import type { LocalTask } from "../../shared/local-model";
import type { PlanBlock } from "../../shared/planning-model";
import { minuteString, parseMinute } from "../../shared/planning-model";

export default function TaskSchedulePanel({day,tasks,blocks,onChanged}:{
  day:string; tasks:readonly LocalTask[]; blocks:readonly PlanBlock[];
  onChanged:()=>Promise<void>;
}){
  const [open,setOpen]=useState(false);
  const [editing,setEditing]=useState<string|null>(null);
  const [taskId,setTaskId]=useState("");
  const [targetDay,setTargetDay]=useState(day);
  const [clock,setClock]=useState("18:00");
  const [duration,setDuration]=useState(45);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const available=tasks.filter(t=>t.visible&&!t.completed);
  const dayBlocks=blocks.filter(block=>block.day===day);

  useEffect(()=>{
    setOpen(false);setEditing(null);setTargetDay(day);
    setError("");setNotice("");
  },[day]);

  function create():void {
    setEditing(null);setTargetDay(day);setClock("18:00");setDuration(45);
    setTaskId(available[0]?.id??"");setOpen(true);
    setError("");setNotice("");
  }
  function edit(block:PlanBlock):void {
    setEditing(block.id);setTargetDay(block.day);
    setClock(minuteString(block.startMinute));
    setDuration(block.durationMinutes);setOpen(true);
    setError("");setNotice("");
  }

  async function save(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const slot={day:targetDay,startMinute:parseMinute(clock),durationMinutes:duration};
      if(editing){
        await window.desktop.planning.editBlock({blockId:editing,...slot});
        setNotice("已更新这一段任务执行时间。任务截止日期未改变。");
      }else{
        await window.desktop.planning.manualCreate({taskId,...slot});
        setNotice("已将任务的计划执行时间添加到日历。任务截止日期未改变。");
      }
      await onChanged();
      setOpen(false);setEditing(null);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"保存学习时间失败");
    }finally{setBusy(false);}
  }

  async function remove(block:PlanBlock):Promise<void>{
    if(busy||!window.confirm('仅删除「'+block.taskTitle+'」的这一个计划时间块？不会删除原任务或其他时间块。'))return;
    setBusy(true);setError("");setNotice("");
    try{
      const removed=await window.desktop.planning.removeBlock(block.id);
      if(!removed)throw Error("这段时间块已经不存在，请刷新日历");
      await onChanged();
      if(editing===block.id){setOpen(false);setEditing(null);}
      setNotice("已删除这一段计划执行时间。任务本身仍然保留。");
    }catch(reason){
      setError(reason instanceof Error?reason.message:"删除学习时间失败");
    }finally{setBusy(false);}
  }

  return <div className="task-schedule-panel">
    <div className="task-schedule-heading">
      <div><h3>任务执行时间</h3><p className="help-text">计划时间可以修改、单独删除，也可以为同一任务安排多段；不会改变截止日期或 Canvas 原始作业。</p></div>
      <button type="button" className="small-button" disabled={!available.length||busy}
        onClick={create}>+ 安排任务时间</button>
    </div>
    {dayBlocks.length?<ul className="schedule-block-list">{dayBlocks.map(block=>
      <li key={block.id}>
        <div className="schedule-block-detail">
          <strong>{block.taskTitle}</strong>
          <span>{block.day} · {minuteString(block.startMinute)}–{minuteString(block.startMinute+block.durationMinutes)} · {block.durationMinutes} 分钟</span>
        </div>
        <div className="button-row">
          <button type="button" className="small-button" disabled={busy} onClick={()=>edit(block)}>修改时间</button>
          <button type="button" className="small-button" disabled={busy} onClick={()=>void remove(block)}>删除本段</button>
        </div>
      </li>
    )}</ul>:<p className="empty-state">选中日期没有计划执行时间。可以手动安排，也可以在「学习规划」中确认建议。</p>}
    {open&&<form className="task-time-form" onSubmit={event=>void save(event)}>
      <h4>{editing?"修改已确认的执行时间":"手动安排任务执行时间"}</h4>
      {!editing&&<label>选择任务
        <select required value={taskId} disabled={busy}
          onChange={e=>setTaskId(e.target.value)}>
          <option value="" disabled>请选择任务</option>
          {available.map(task=><option value={task.id} key={task.id}>{task.title}{task.dueDate?" · 截止 "+task.dueDate:""}</option>)}
        </select>
      </label>}
      {editing&&<p className="privacy-note">修改这段已确认的时间，不会调整所属任务或同批次的其他学习安排。</p>}
      <div className="task-time-fields">
        <label>执行日期<input type="date" required value={targetDay} disabled={busy}
          onChange={e=>setTargetDay(e.target.value)}/></label>
        <label>开始时间<input type="time" required step={300} value={clock} disabled={busy}
          onChange={e=>setClock(e.target.value)}/></label>
        <label>时长（分钟）<input type="number" min={15} max={480} step={5} required
          value={duration} disabled={busy} onChange={e=>setDuration(Number(e.target.value))}/></label>
      </div>
      <p className="privacy-note">支持 15–480 分钟、每 5 分钟一档；不能跨过午夜，不能与课程或其他已确认计划重叠。</p>
      <div className="button-row">
        <button className="primary-button" disabled={busy||(!editing&&!taskId)} type="submit">
          {busy?"保存中…":editing?"保存时间修改":"确认安排"}
        </button>
        <button className="small-button" disabled={busy} type="button" onClick={()=>{setOpen(false);setEditing(null);}}>取消</button>
      </div>
    </form>}
    {error&&<p role="alert" className="error-message">{error}</p>}
    {notice&&<p role="status" className="success-text">{notice}</p>}
  </div>;
}
