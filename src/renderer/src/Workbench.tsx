import {useEffect,useMemo,useState} from "react";
import type {FocusSummary,LocalTask} from "../../shared/local-model";
import type {PlanBlock} from "../../shared/planning-model";
import type {CalendarDisplayEvent} from "../../shared/canvas-calendar-model";
import type {ReviewProgress,KnowledgeDocument} from "../../shared/knowledge-model";
import type {CloudSessionStatus} from "../../shared/cloud-model";
import type {CanvasConnectionStatus} from "../../shared/canvas-model";
import type {MailSyncState} from "../../shared/mail-model";
import type {AIStatus} from "../../shared/ai-model";
import {formatDueDate,localDateKey} from "./calendar";
import {minuteString} from "../../shared/planning-model";
import {
  WORKBENCH_STORAGE_KEY,WORKBENCH_WIDGETS,
  loadWorkbenchLayout,presetLayout,saveWorkbenchLayout,
  moveWorkbenchWidget,setWidgetVisible,visibleWorkbenchWidgets,
  type WorkbenchWidget,type WorkbenchPreset,
} from "./workbench-layout";
import {workbenchTaskSummary,workbenchDaySchedule} from "./workbench-data";
import "./workbench.css";

type Source<T>={state:"loading"}|{state:"ready";value:T}|{state:"error"};
type Sources={
  review:Source<ReviewProgress>;
  documents:Source<KnowledgeDocument[]>;
  cloud:Source<CloudSessionStatus>;
  workspaces:Source<number>;
  canvas:Source<CanvasConnectionStatus>;
  mail:Source<MailSyncState>;
  ai:Source<AIStatus>;
};
const loading=<T,>():Source<T>=>({state:"loading"});
const fromResult=<T,>(result:PromiseSettledResult<T>):Source<T>=>
  result.status==="fulfilled"?{state:"ready",value:result.value}:{state:"error"};
const initial=():Sources=>({
  review:loading(),documents:loading(),cloud:loading(),
  workspaces:loading(),canvas:loading(),mail:loading(),ai:loading(),
});
export type WorkbenchDestination=
  "calendar"|"focus"|"knowledge"|"team"|"connectors"|"mail"|"assistant"|"ai";
type Props={
  tasks:readonly LocalTask[];
  summary:FocusSummary;
  plannedBlocks:readonly PlanBlock[];
  fixedEvents:readonly CalendarDisplayEvent[];
  version:string;
  runtime:"checking"|"connected"|"unavailable";
  refreshSignal:number;
  busy:boolean;
  onNavigate:(page:WorkbenchDestination)=>void;
  onEditTask:(task:LocalTask)=>void;
  onCompleteTask:(task:LocalTask)=>void;
};
const labels:Record<WorkbenchWidget,{title:string;hint:string;page:WorkbenchDestination}>={
  tasks:{title:"待办任务",hint:"个人日历",page:"calendar"},
  schedule:{title:"今日学习安排",hint:"已确认的计划与课程",page:"calendar"},
  focus:{title:"专注与奖励",hint:"本机累计执行",page:"focus"},
  knowledge:{title:"知识库与复习",hint:"本机资料与到期卡",page:"knowledge"},
  team:{title:"小组协作",hint:"当前授权账号",page:"team"},
  canvas:{title:"Canvas 课程",hint:"个人同步连接",page:"connectors"},
  mail:{title:"邮箱管理",hint:"个人授权邮箱",page:"mail"},
  ai:{title:"AI 学习助手",hint:"用户自己的服务商",page:"assistant"},
};
const presets:Record<WorkbenchPreset,string>={
  balanced:"均衡",study:"学习优先",collaboration:"协作优先",
};
function stateCopy<T>(source:Source<T>,render:(value:T)=>string):string{
  if(source.state==="loading")return "正在读取…";
  if(source.state==="error")return "暂时无法读取，请进入模块检查";
  return render(source.value);
}
function timestamp(value:string|null):string{
  if(!value)return "尚未完成首次同步";
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleString("zh-CN"):"时间未确认";
}

/** Overview only: reads existing trusted Main IPC DTOs. It does not query
 * remote services until a user has already signed in to that connector, and
 * never uploads, modifies or caches private task/mail/team data itself. */
export default function Workbench({
  tasks,summary,plannedBlocks,fixedEvents,version,runtime,refreshSignal,
  busy,onNavigate,onEditTask,onCompleteTask,
}:Props){
  const [layout,setLayout]=useState(()=>{
    try{return loadWorkbenchLayout(window.localStorage.getItem(WORKBENCH_STORAGE_KEY));}
    catch{return presetLayout();}
  });
  const [layoutOpen,setLayoutOpen]=useState(false);
  const [storageWarning,setStorageWarning]=useState("");
  const [sources,setSources]=useState<Sources>(initial);
  const [retried,setRetried]=useState(0);
  const [updatedAt,setUpdatedAt]=useState<Date|null>(null);
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{
    try{
      window.localStorage.setItem(WORKBENCH_STORAGE_KEY,saveWorkbenchLayout(layout));
      setStorageWarning("");
    }catch{
      setStorageWarning("当前系统拒绝保存工作台布局，重新启动后将恢复默认显示。");
    }
  },[layout]);
  // Refresh the local civil day without converting deadlines to UTC.
  useEffect(()=>{
    const timer=window.setInterval(()=>setNow(new Date()),60_000);
    return()=>window.clearInterval(timer);
  },[]);
  useEffect(()=>{
    let active=true;
    setSources(initial());
    setUpdatedAt(null);
    const refresh=async()=>{
      const [review,documents,cloud,canvas,mail,ai]=await Promise.allSettled([
        window.desktop.knowledge.progress(),window.desktop.knowledge.documents(),
        window.desktop.cloud.status(),window.desktop.canvas.status(),
        window.desktop.mail.status(),window.desktop.ai.status(),
      ]);
      if(!active)return;
      setSources({
        review:fromResult(review),documents:fromResult(documents),
        cloud:fromResult(cloud),canvas:fromResult(canvas),
        mail:fromResult(mail),ai:fromResult(ai),workspaces:loading(),
      });
      setUpdatedAt(new Date());
      if(cloud.status==="fulfilled"&&cloud.value.authenticated){
        try{
          const workspaces=await window.desktop.cloud.workspaces();
          if(active)setSources(previous=>({
            ...previous,workspaces:{state:"ready",value:workspaces.length},
          }));
        }catch{
          if(active)setSources(previous=>({...previous,workspaces:{state:"error"}}));
        }
      }
    };
    void refresh();
    return()=>{active=false;};
  },[refreshSignal,retried]);
  const today=localDateKey(now);
  const taskData=useMemo(()=>workbenchTaskSummary(tasks,today),[tasks,today]);
  const schedule=useMemo(()=>
    workbenchDaySchedule(plannedBlocks,fixedEvents,today),[plannedBlocks,fixedEvents,today]);
  const visible=visibleWorkbenchWidgets(layout);
  function widgetBody(widget:WorkbenchWidget){
    switch(widget){
      case "tasks":
        return <>
          <div className="wb-mini-stats">
            <span><strong>{taskData.today}</strong> 今日截止</span>
            <span><strong>{taskData.overdue}</strong> 已逾期</span>
            <span><strong>{taskData.pending}</strong> 未完成</span>
          </div>
          {taskData.preview.length?<ul className="wb-entries">
            {taskData.preview.map(task=><li key={task.id} className="wb-task-row">
              <div className="wb-entry-body">
                <strong>{task.title}</strong>
                <small>{formatDueDate(task.dueDate)}
                  {task.priority==="high"?" · 高优先级":""}</small>
              </div>
              <div className="wb-entry-actions">
                <button type="button" disabled={busy||runtime!=="connected"}
                  aria-label={"标记完成："+task.title}
                  onClick={()=>onCompleteTask(task)}>完成</button>
                <button type="button" disabled={busy}
                  aria-label={"编辑任务："+task.title}
                  onClick={()=>onEditTask(task)}>编辑</button>
              </div>
            </li>)}
          </ul>:<p className="wb-empty">目前没有未完成的可见任务。可以打开日历新建任务。</p>}
        </>;
      case "schedule":
        return <>
          <p className="wb-intro">{today} · 已确认安排 {schedule.count} 项
            （不计尚未采纳的 AI 建议）。</p>
          {schedule.count>0?<ul className="wb-entries">
            {schedule.fixed.map(e=><li key={"event:"+e.id}>
              <strong>{minuteString(e.startMinute)} · {e.title}</strong>
              <small>{e.source==="canvas"?"Canvas 已同步课程":"固定课程"}</small>
            </li>)}
            {schedule.planned.map(b=><li key={"block:"+b.id}>
              <strong>{minuteString(b.startMinute)} · {b.taskTitle}</strong>
              <small>已确认学习时间 · {b.durationMinutes} 分钟</small>
            </li>)}
          </ul>:<p className="wb-empty">今天没有已确认的课程或学习时间块。</p>}
          {schedule.count>10&&<small>这里只预览前 10 项，请在日历查看全部。</small>}
        </>;
      case "focus":
        return <>
          <div className="wb-mini-stats">
            <span><strong>{summary.totalMinutes}</strong> 累计分钟</span>
            <span><strong>{summary.completedSessions}</strong> 完成场次</span>
            <span><strong>{summary.points}</strong> 已获积分</span>
          </div>
          <p className="wb-intro">仅统计本机实际保存的专注记录；不会把计划时间当成真实执行。</p>
        </>;
      case "knowledge":
        return <>
          <p className="wb-highlight">{stateCopy(sources.review,p=>p.due+" 张待复习卡")}</p>
          <p className="wb-intro">
            {stateCopy(sources.documents,docs=>docs.length+" 份本机资料")}
            {" · "}
            {stateCopy(sources.review,p=>"共有 "+p.total+" 张卡片，本日已复习 "+p.reviewedToday+" 张")}
          </p>
          <small>仅本机知识库状态，不在工作台读取或展示资料正文。</small>
        </>;
      case "team":
        return <>
          <p className="wb-highlight">{stateCopy(sources.cloud,c=>
            c.authenticated?"已登录团队账号":c.configured?"尚未登录":"尚未配置 Supabase")}</p>
          <p className="wb-intro">{sources.cloud.state==="ready"&&sources.cloud.value.authenticated?
            stateCopy(sources.workspaces,n=>"当前有权访问的小组："+n+" 个"):
            "登录后才能从已授权云端读取小组数量。"}</p>
          <small>不会显示其他成员的私信、个人任务或邮箱内容。五人联机与 RLS 仍需真实验收。</small>
        </>;
      case "canvas":
        return <>
          <p className="wb-highlight">{stateCopy(sources.canvas,c=>
            c.connected?"已连接个人 Canvas":"尚未连接")}</p>
          <p className="wb-intro">{sources.canvas.state==="ready"&&sources.canvas.value.connected?
            "通过已授权的个人连接器同步课程与作业；进入模块可检查同步记录。":
            "登录自己的学校 Canvas 账号后，可从连接器查看课程和作业同步。"}</p>
          <small>当前个人 Token 模式不代表学校 OAuth 多人接入已验收。</small>
        </>;
      case "mail":
        return <>
          <p className="wb-highlight">{stateCopy(sources.mail,m=>
            m.connected?"已连接邮箱 · "+m.messageCount+" 封缓存邮件":"尚未连接邮箱")}</p>
          <p className="wb-intro">{sources.mail.state==="ready"&&sources.mail.value.connected?
            "最近同步："+timestamp(sources.mail.value.lastSuccess):
            "邮件正文只会在明确授权后读取；不会自动交给 AI。"}</p>
          <small>邮件由个人授权管理，工作台不会获取或发送邮件正文。</small>
        </>;
      case "ai":
        return <>
          <p className="wb-highlight">{stateCopy(sources.ai,a=>
            a.connected?(a.provider+" · "+a.model):"尚未配置个人 AI Key")}</p>
          <p className="wb-intro">{sources.ai.state==="ready"&&sources.ai.value.connected?
            "剩余每日请求次数："+sources.ai.value.remainingToday+" / "+
              sources.ai.value.dailyRequestLimit:
            "可配置 OpenAI、DeepSeek、Gemini、Anthropic 或兼容 API。"}</p>
          <small>不会在工作台自动调用付费 API，发送内容前仍需预览与确认。</small>
        </>;
    }
  }
  return <div className="wb-page">
    <div className="wb-intro-row">
      <div><div className="eyebrow">PERSONAL WORKBENCH · V0.1 ALPHA</div>
        <h1>把重要的事情，一步步做好。</h1>
        <p>真实本机任务、学习进度与已授权连接器的状态，不使用虚构演示数据。</p>
      </div>
      <div className="date-card"><span>当前版本</span><strong>{version}</strong>
        <small>五人内部 Alpha 开发中</small></div>
    </div>
    <section className="wb-runtime" aria-label="工作台运行状态">
      <span className={runtime==="connected"?"wb-dot live":"wb-dot"}/>
      <div><strong>本机数据库：{runtime==="connected"?"已连接":
        runtime==="checking"?"检查中":"暂时不可用"}</strong>
        <p>云端、Canvas、邮件与 AI 各自独立授权；本机数据不会因此自动共享。</p>
      </div>
      <button type="button" className="secondary-button"
        onClick={()=>setRetried(n=>n+1)}>刷新模块状态</button>
    </section>
    <div className="wb-metrics" aria-label="本机任务和专注概况">
      <div><span>今日截止</span><strong>{taskData.today}</strong></div>
      <div><span>逾期待办</span><strong>{taskData.overdue}</strong></div>
      <div><span>全部待办</span><strong>{taskData.pending}</strong></div>
      <div><span>累计专注</span><strong>{summary.totalMinutes}<small> 分钟</small></strong></div>
    </div>
    <div className="wb-heading-row">
      <div><h2>我的模块</h2>
        <small>{visible.length} / {WORKBENCH_WIDGETS.length} 个组件显示
          {updatedAt?" · 状态读取："+updatedAt.toLocaleTimeString("zh-CN"):""}</small>
      </div>
      <button type="button" className="secondary-button"
        aria-expanded={layoutOpen} aria-controls="wb-settings"
        onClick={()=>setLayoutOpen(open=>!open)}>
        {layoutOpen?"收起布局设置":"自定义工作台布局"}
      </button>
    </div>
    {layoutOpen&&<section id="wb-settings" className="wb-settings" aria-label="工作台组件布局">
      <p>选择预设、隐藏不常用的组件或按顺序移动。只保存组件配置到本机，
        不保存任务、邮件正文或团队内容。</p>
      <div className="wb-presets" role="group" aria-label="工作台布局预设">
        {(["balanced","study","collaboration"] as const).map(p=><button
          key={p} type="button"
          className={layout.preset===p?"chip selected":"chip"}
          aria-pressed={layout.preset===p}
          onClick={()=>setLayout(presetLayout(p))}>{presets[p]}</button>)}
      </div>
      <ul className="wb-layout-list" aria-label="工作台组件顺序">
        {layout.order.map((key,index)=><li key={key}>
          <label><input type="checkbox"
            checked={!layout.hidden.includes(key)}
            onChange={e=>setLayout(current=>setWidgetVisible(current,key,e.target.checked))}/>
            {" "}{labels[key].title}</label>
          <div className="wb-order-actions">
            <button type="button" disabled={index===0}
              onClick={()=>setLayout(current=>moveWorkbenchWidget(current,key,-1))}
              aria-label={"上移"+labels[key].title}>↑</button>
            <button type="button" disabled={index===layout.order.length-1}
              onClick={()=>setLayout(current=>moveWorkbenchWidget(current,key,1))}
              aria-label={"下移"+labels[key].title}>↓</button>
          </div>
        </li>)}
      </ul>
      <button type="button" className="text-button"
        onClick={()=>setLayout(presetLayout())}>重置默认布局</button>
      {storageWarning&&<p role="status" className="wb-warning">{storageWarning}</p>}
    </section>}
    {visible.length===0&&<div className="panel wb-empty-all">
      <h3>所有模块都已隐藏</h3>
      <p>打开布局设置可逐个恢复，或者直接恢复默认八模块工作台。</p>
      <button className="primary-button" type="button"
        onClick={()=>setLayout(presetLayout())}>显示全部模块</button>
    </div>}
    <div className="wb-grid" aria-label="八模块状态">
      {visible.map(key=><section className="panel wb-card" key={key}
        aria-label={labels[key].title}>
        <div className="wb-card-header">
          <div><div className="eyebrow">{labels[key].hint}</div>
            <h3>{labels[key].title}</h3></div>
          <button type="button" className="text-button"
            onClick={()=>onNavigate(labels[key].page)}
            aria-label={"打开"+labels[key].title}>打开模块 →</button>
        </div>
        {widgetBody(key)}
      </section>)}
    </div>
    <p className="wb-disclaimer">
      连接状态不代表已完成 Canvas、交大邮箱或 Supabase 五人真实联机验收。
      本页只读取状态；所有外部数据访问与付费 AI 调用仍在各模块受用户控制。
    </p>
  </div>;
}
