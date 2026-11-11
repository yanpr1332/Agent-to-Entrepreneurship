import {useEffect,useState,type FormEvent} from "react";
import {timesOverlap,type BusySlot,type FixedEvent,type ICSPreview} from "../../shared/fixed-calendar-model";
import {dayOffset,minuteString,parseMinute} from "../../shared/planning-model";

function errorText(e:unknown):string{return e instanceof Error?e.message:"日历操作失败";}

/** Fixed events remain independent of tasks and are never uploaded automatically. */
export default function FixedCalendarPanel({day,events,studyBlocks,onChanged}:{
  day:string;events:FixedEvent[];studyBlocks:BusySlot[];onChanged:()=>Promise<void>;
}){
  const [title,setTitle]=useState("");
  const [start,setStart]=useState("09:00");
  const [end,setEnd]=useState("10:00");
  const [weeks,setWeeks]=useState(1);
  const [editing,setEditing]=useState<string|null>(null);
  const [editDay,setEditDay]=useState(day);
  const [preview,setPreview]=useState<ICSPreview|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{setPreview(null);setEditing(null);setEditDay(day);},[day]);
  async function run(callback:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await callback();}catch(e){setError(errorText(e));}
    finally{setBusy(false);}
  }
  function cancelEdit():void{setEditing(null);setTitle("");setEditDay(day);setStart("09:00");setEnd("10:00");}
  function beginEdit(item:FixedEvent):void{
    setEditing(item.id);setEditDay(item.day);setTitle(item.title);
    setStart(minuteString(item.startMinute));
    setEnd(minuteString(item.startMinute+item.durationMinutes));
    setWeeks(1);
  }
  async function create(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      const from=parseMinute(start),to=parseMinute(end);
      if(to-from<15)throw Error("课程结束时间必须晚于开始时间，且至少 15 分钟");
      if(editing){
        await window.desktop.calendar.edit({id:editing,title,day:editDay,
          startMinute:from,durationMinutes:to-from});
        await onChanged();cancelEdit();
        setNotice("已保存这一条事件的修改，不影响同一系列的其他日期。");
      }else{
        const result=await window.desktop.calendar.create({
          title,day,startMinute:from,durationMinutes:to-from,weeks,
        });
        await onChanged();setTitle("");
        setNotice("已保存 "+result.length+" 个本机固定事件，学习规划将自动避开这些时间。");
      }
    });
  }
  async function remove(item:FixedEvent):Promise<void>{
    if(!window.confirm("删除「"+item.title+"」这一次事件？不会删除任务或修改其他周课程。"))return;
    await run(async()=>{
      await window.desktop.calendar.remove(item.id);
      await onChanged();
      setNotice("已删除这一条固定事件。");
    });
  }
  async function removeSeries(item:FixedEvent):Promise<void>{
    if(!item.seriesId)return;
    const count=events.filter(e=>e.seriesId===item.seriesId).length;
    if(!window.confirm("确认删除同一系列的 "+count+" 个固定事件？这不会删除任务或学习计划。"))return;
    await run(async()=>{
      const removed=await window.desktop.calendar.removeSeries(item.id);
      await onChanged();cancelEdit();
      setNotice("已删除系列中的 "+removed+" 个事件。");
    });
  }
  async function pickICS():Promise<void>{
    await run(async()=>{
      setPreview(await window.desktop.calendar.previewICS());
      setNotice("已读取本地文件并解析预览。尚未写入日历。");
    });
  }
  async function importICS():Promise<void>{
    if(!preview)return;
    const accepted=preview;
    if(!window.confirm("确认导入预览中的 "+accepted.events.length+" 个事件？会占用学习规划时间。"))return;
    await run(async()=>{
      try{
        const result=await window.desktop.calendar.confirmICS(accepted.approvalId);
        await onChanged();
        setNotice("已导入 "+result.added+" 项；按 UID 跳过已存在的 "+result.alreadyPresent+" 项。");
      }finally{setPreview(null);}
    });
  }
  async function cancelImport():Promise<void>{
    if(!preview)return;
    const accepted=preview;
    await run(async()=>{
      await window.desktop.calendar.cancelICS(accepted.approvalId);
      setPreview(null);
      setNotice("已取消 ICS 导入授权，未写入日历。");
    });
  }
  async function exportLocal():Promise<void>{
    if(!window.confirm("导出本机固定课程与已导入事件到 .ics？文件包含活动标题和时间，可能涉及个人课表。不会上传到网络或包含私人任务/邮件。"))return;
    await run(async()=>{
      const result=await window.desktop.calendar.exportICS();
      setNotice(result.saved?"已导出 "+result.eventCount+" 个固定事件。文件保存在你选择的本地位置。":"已取消导出。");
    });
  }
  const current=events.filter(e=>e.day===day);
  const manualConflicts=(()=>{
    if(!title.trim()||!start||!end)return [] as string[];
    let from:number,to:number;
    try{from=parseMinute(start);to=parseMinute(end);}catch{return [];}
    if(to-from<15)return [];
    const group=editing? [{day:editDay,startMinute:from,durationMinutes:to-from}] :
      Array.from({length:weeks},(_,i)=>({day:dayOffset(day,i*7),startMinute:from,durationMinutes:to-from}));
    return group.flatMap(slot=>[
      ...events.filter(e=>e.id!==editing&&timesOverlap(e,slot)).map(e=>slot.day+" · 与固定事项「"+e.title+"」重叠"),
      ...studyBlocks.filter(b=>timesOverlap(b,slot)).map(()=>slot.day+" · 与已确认学习时间重叠，保存将被拒绝"),
    ]).slice(0,12);
  })();
  const previewConflicts=preview?.events.flatMap(slot=>[
    ...events.filter(e=>timesOverlap(e,slot)).map(e=>slot.day+" · "+slot.title+" / "+e.title),
    ...studyBlocks.filter(b=>timesOverlap(b,slot)).map(()=>slot.day+" · 与已确认学习时间冲突（无法导入）"),
  ]).slice(0,12)??[];
  return <section className="panel fixed-calendar-panel">
    <div className="eyebrow">LOCAL FIXED EVENTS</div>
    <h2>固定课程与 ICS 日历</h2>
    <p className="privacy-note">课程和导入的事件保存在本机，与任务截止日期分离。学习规划、AI 候选及最终应用均避开这些时间。手动按周重复最多 16 周；日历数据不自动同步至 Canvas 或其他服务。</p>
    {error&&<div className="error-banner" role="alert">{error}
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <h3>{day} · 固定事项 ({current.length})</h3>
    {current.length?<ul className="planned-day-list">{current.map(item=><li key={item.id}>
      <span>{minuteString(item.startMinute)}–{minuteString(item.startMinute+item.durationMinutes)}</span>
      <strong>{item.title}</strong>
      {item.startMinute+item.durationMinutes<1440&&<button className="text-button" disabled={busy}
        onClick={()=>beginEdit(item)}>编辑单次</button>}
      {item.seriesId&&<button className="text-button" disabled={busy}
        onClick={()=>void removeSeries(item)}>删除整组</button>}
      <button className="text-button" disabled={busy} onClick={()=>void remove(item)}>删除单次</button>
    </li>)}</ul>:<p className="empty-state">当天无固定事项。</p>}
    <form className="fixed-calendar-form" onSubmit={event=>void create(event)}>
      <h3>{editing?"编辑单次事件":"创建固定课程"}</h3>
      {editing&&<label>修改后的日期<input type="date" required value={editDay}
        disabled={busy} onChange={e=>setEditDay(e.target.value)}/></label>}
      <label>课程或事项名称<input required maxLength={120} value={title}
        disabled={busy} onChange={e=>setTitle(e.target.value)} placeholder="例如：微积分课"/></label>
      <div className="fixed-clock-row">
        <label>开始<input type="time" step={900} required value={start} disabled={busy}
          onChange={e=>setStart(e.target.value)}/></label>
        <label>结束<input type="time" step={900} required value={end} disabled={busy}
          onChange={e=>setEnd(e.target.value)}/></label>
      </div>
      {!editing&&<label>重复周数（同一星期几）
        <select value={weeks} disabled={busy} onChange={e=>setWeeks(Number(e.target.value))}>
          {[1,2,4,8,12,16].map(n=><option key={n} value={n}>{n} 周</option>)}
        </select>
      </label>}
      {manualConflicts.length>0&&<div className="retention-warning" role="status">
        <strong>时间冲突提示（显示前 12 条）</strong><ul>{manualConflicts.map((msg,i)=><li key={i}>{msg}</li>)}</ul>
      </div>}
      <button className="primary-button" disabled={busy} type="submit">{editing?"保存单次修改":"在选中日期创建固定事件"}</button>
      {editing&&<button className="secondary-button" type="button" disabled={busy} onClick={cancelEdit}>取消编辑</button>}
    </form>
    <div className="button-row">
      <button className="secondary-button" disabled={busy||!!preview} onClick={()=>void pickICS()}>选择 ICS 文件并预览</button>
      <button className="secondary-button" disabled={busy} onClick={()=>void exportLocal()}>导出固定日历为 ICS</button>
    </div>
    {preview&&<div className="ai-preview" role="region" aria-label="ICS 导入确认">
      <h3>导入前核对：{preview.filename}</h3>
      <p>共 {preview.events.length} 个待导入事件（每次重复均列为独立日期）。确认在 {new Date(preview.expiresAt).toLocaleString("zh-CN")} 前有效。</p>
      {previewConflicts.length>0&&<div className="retention-warning" role="alert">
        <strong>检测到日程重叠（前 12 条）</strong>
        <ul>{previewConflicts.map((msg,i)=><li key={i}>{msg}</li>)}</ul>
        <p>与现有固定事项重叠时可以并存；与已确认学习时间冲突时导入会被拒绝，请先调整时间。</p>
      </div>}
      <ul className="fixed-import-events">{preview.events.map((item,i)=><li key={i}>
        <strong>{item.title}</strong> · {item.day} {minuteString(item.startMinute)}–{minuteString(item.startMinute+item.durationMinutes)}
      </li>)}</ul>
      <div className="button-row">
        <button className="primary-button" disabled={busy} onClick={()=>void importICS()}>确认导入以上全部事件</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void cancelImport()}>取消预览</button>
      </div>
    </div>}
    <p className="privacy-note">ICS 支持单日事件、UTC/本地浮动时间、IANA TZID 时区以及有限周重复（COUNT 1–250、BYDAY、INTERVAL 1–8，最多两年）。夏令时跳时或歧义时刻、UNTIL/EXDATE、跨夜课程及其他不支持的复杂规则会整文件拒绝，避免错误安排。可编辑单次事件，新增重复系列可整组删除；旧版本独立课程仍需单条删除。导出使用设备本地浮动时间，不覆盖已有文件。</p>
  </section>;
}
