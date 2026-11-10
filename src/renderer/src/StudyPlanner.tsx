import { useEffect, useState, type FormEvent } from "react";
import type {
  AppliedPlanBatch, PlanBlock, PlanProposal, PlanningSettings,
} from "../../shared/planning-model";
import { dayOffset, minuteString, parseMinute } from "../../shared/planning-model";
import { localDateKey } from "./calendar";

function readable(e:unknown):string{
  return e instanceof Error?e.message:"无法完成规划操作，请重新生成建议";
}
const currentDay=()=>localDateKey(new Date());

export default function StudyPlanner({onChanged}:{
  onChanged:()=>Promise<void>;
}){
  const [settings,setSettings]=useState<PlanningSettings>({
    startDate:currentDay(),days:7,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45,
  });
  const [proposal,setProposal]=useState<PlanProposal|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [edits,setEdits]=useState<Record<string,{day:string;startMinute:number}>>({});
  const [blocks,setBlocks]=useState<PlanBlock[]>([]);
  const [batches,setBatches]=useState<AppliedPlanBatch[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  async function reload():Promise<void>{
    const [nextBlocks,nextBatches]=await Promise.all([
      window.desktop.planning.blocks(),window.desktop.planning.batches(),
    ]);
    setBlocks(nextBlocks);setBatches(nextBatches);
  }
  useEffect(()=>{
    let active=true;
    void Promise.all([
      window.desktop.planning.blocks(),window.desktop.planning.batches(),
      window.desktop.planning.proposals(),
    ]).then(([loaded,history,proposals])=>{
      if(!active)return;
      setBlocks(loaded);setBatches(history);
      const pending=proposals.find(p=>p.blocks.some(b=>b.state==="proposed"));
      if(pending){
        setProposal(pending);
        setSelected(pending.blocks.filter(b=>b.state==="proposed").map(b=>b.id));
      }
    }).catch(e=>{if(active)setError(readable(e));});
    return()=>{active=false;};
  },[]);

  async function run(callback:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await callback();}catch(e){setError(readable(e));}
    finally{setBusy(false);}
  }
  async function generate(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      const next=await window.desktop.planning.generate(settings);
      setProposal(next);
      setSelected(next.blocks.map(b=>b.id));
      setEdits({});
      setNotice(`生成 ${next.blocks.length} 个候选时间块，另外 ${next.skipped.length} 个任务暂未安排。所有候选均未应用。`);
    });
  }
  async function apply():Promise<void>{
    if(!proposal || selected.length===0)return;
    if(!window.confirm(`确认只应用选中的 ${selected.length} 个时间块？任务截止日期和完成状态不会改变。`))return;
    await run(async()=>{
      const batch=await window.desktop.planning.apply({
        proposalId:proposal.id,blockIds:selected,
        edits:Object.entries(edits).filter(([id])=>selected.includes(id))
          .map(([blockId,values])=>({blockId,...values})),
      });
      const current=await window.desktop.planning.proposals();
      setProposal(current.find(p=>p.id===proposal.id)??null);
      setSelected([]);
      setEdits({});
      await reload();
      await onChanged();
      setNotice(`成功应用 ${batch.blocks.length} 段学习时间。可以通过下方「撤销整批」恢复。`);
    });
  }
  async function undo(batchId:string):Promise<void>{
    if(!window.confirm("撤销本次规划写入的全部时间块？不会删除任务或更改截止日期。"))return;
    await run(async()=>{
      const success=await window.desktop.planning.undo(batchId);
      if(!success)throw Error("批次已撤销或不存在");
      await reload();await onChanged();
      setNotice("已撤销整批学习时间块，个人任务未变化。");
    });
  }

  function patch(id:string,update:Partial<{day:string;startMinute:number}>,original:PlanBlock):void{
    setEdits(previous=>({
      ...previous,[id]:{day:previous[id]?.day??original.day,
        startMinute:previous[id]?.startMinute??original.startMinute,...update},
    }));
  }
  const remaining=proposal?.blocks.filter(b=>b.state==="proposed")??[];

  return <section className="planner-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow">LOCAL SCHEDULE PROPOSALS</div>
        <h1>学习规划 · 人工审核</h1>
        <p>基于当前个人任务生成时间建议，支持修改、部分应用和批次撤销</p>
      </div>
      <span className="count-chip">{blocks.length} 段已确认计划</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>当前为离线规则规划，不是云端 AI。</strong>
      只读取本机当前可见且未完成的任务，按截止日期和优先级排序。不会读取邮件正文、
      搜索文件夹、调用模型、移动锁定课程或修改任务截止日期。没有外部课表冲突信息；
      请在应用前核对自己的固定课程和其他日程。时间按照当前设备的本地日历日期显示。
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <div className="planner-layout">
      <section className="panel">
        <div className="eyebrow">PLANNING WINDOW</div>
        <h2>生成学习时间建议</h2>
        <form className="planner-form" onSubmit={event=>void generate(event)}>
          <label>从哪一天开始
            <input type="date" required min={currentDay()} value={settings.startDate}
              onChange={event=>setSettings({...settings,startDate:event.target.value})}/>
          </label>
          <label>规划未来天数（1–21）
            <input type="number" required min={1} max={21} value={settings.days}
              onChange={event=>setSettings({...settings,days:Number(event.target.value)})}/>
          </label>
          <label>每日最早开始
            <input type="time" required step={900} value={settings.dailyStart}
              onChange={event=>setSettings({...settings,dailyStart:event.target.value})}/>
          </label>
          <label>每日最晚结束
            <input type="time" required step={900} value={settings.dailyEnd}
              onChange={event=>setSettings({...settings,dailyEnd:event.target.value})}/>
          </label>
          <label>每项任务预计学习时间
            <select value={settings.minutesPerTask}
              onChange={event=>setSettings({...settings,minutesPerTask:Number(event.target.value)})}>
              {[15,30,45,60,75,90,105,120].map(n=><option key={n} value={n}>{n} 分钟</option>)}
            </select>
          </label>
          <button className="primary-button full-width" disabled={busy} type="submit">
            {busy?"规划中…":"生成候选（不会修改正式日历）"}
          </button>
        </form>
        <p className="privacy-note">每个未完成任务在一次建议中最多安排一段。时长是估算值，可重新生成不同规划；没有 AI 或考试智能拆分。</p>
      </section>
      <section className="panel planner-proposal">
        <div className="panel-heading">
          <div><div className="eyebrow">SELECTIVE REVIEW</div><h2>预览与选择性应用</h2></div>
          <span className="muted-tag">{selected.length}/{remaining.length} 段已选</span>
        </div>
        {!proposal?<p className="empty-state">尚未生成计划。先在左侧选择日期、每天空闲时间及估计时长。</p>:
        <>
          {remaining.length===0?<p className="empty-state">当前建议已全部应用。可重新生成新规划。</p>:
          <ul className="planner-candidates">
            {remaining.map(block=>{
              const edited=edits[block.id];
              const day=edited?.day??block.day;
              const time=edited?.startMinute??block.startMinute;
              const until=dayOffset(proposal.settings.startDate,proposal.settings.days-1);
              return <li key={block.id} className="planner-candidate">
                <label className="planner-select">
                  <input type="checkbox" checked={selected.includes(block.id)} disabled={busy}
                    onChange={event=>setSelected(previous=>event.target.checked
                      ? [...previous,block.id] : previous.filter(id=>id!==block.id))}/>
                  <strong>{block.taskTitle}</strong>
                </label>
                <p>{block.rationale}</p>
                <div className="planner-edit-row">
                  <label>日期
                    <input type="date" value={day} min={proposal.settings.startDate}
                      max={until} disabled={busy}
                      onChange={event=>patch(block.id,{day:event.target.value},block)}/>
                  </label>
                  <label>开始时间
                    <input type="time" step={900} value={minuteString(time)} disabled={busy}
                      onChange={event=>patch(block.id,{
                        startMinute:parseMinute(event.target.value)},block)}/>
                  </label>
                  <span className="muted-tag">{block.durationMinutes} 分钟</span>
                </div>
              </li>;
            })}
          </ul>}
          {proposal.skipped.length>0&&<details className="planner-skipped">
            <summary>{proposal.skipped.length} 项任务尚未安排（查看原因）</summary>
            <ul>{proposal.skipped.map(x=><li key={x.taskId}>{x.reason}</li>)}</ul>
          </details>}
          <button className="primary-button" disabled={busy||selected.length===0}
            onClick={()=>void apply()}>确认应用选中的 {selected.length} 段时间</button>
          <p className="privacy-note">确认时会重新核验任务状态、截止日、时间窗及与其他已确认计划的冲突。任一项冲突则整体拒绝写入，避免部分错误应用。</p>
        </>}
      </section>
    </div>

    <section className="panel">
      <div className="eyebrow">COMMITTED SCHEDULE</div><h2>已确认学习时间</h2>
      {blocks.length?<ul className="planner-committed">{blocks.map(b=>
        <li key={b.id}><strong>{b.taskTitle}</strong><span>{b.day} · {minuteString(b.startMinute)} – {minuteString(b.startMinute+b.durationMinutes)}</span></li>
      )}</ul>:<p className="empty-state">还没有确认的学习时间块。预览候选不会修改这里。</p>}
      {batches.length>0&&<div className="planner-history">
        <div className="eyebrow">UNDO HISTORY</div>
        {batches.map(batch=><div className="planner-batch" key={batch.id}>
          <span>{new Date(batch.appliedAt).toLocaleString("zh-CN")} · {batch.blocks.length} 段</span>
          <button className="secondary-button" disabled={busy}
            onClick={()=>void undo(batch.id)}>撤销这一批</button>
        </div>)}
      </div>}
    </section>
  </section>;
}
