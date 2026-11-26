import { useEffect,useState,type FormEvent } from "react";
import {
  AI_DEFAULT_MODEL, AI_MODEL_DEFAULTS, AI_MAX_PROMPT_CHARS,
  type AIProvider,
  type AIAnswer, type AIPreview, type AIStatus,
} from "../../shared/ai-model";
import type { LocalTask } from "../../shared/local-model";
import {eligibleAIPlanTasks,type AIPlanSuggestion} from "../../shared/ai-planning";
import type {AIProject,AIProjectSourceGrant,AIProjectActionGrant,AIProjectAuditEvent} from "../../shared/ai-project-model";

const empty:AIStatus={
  connected:false,running:false,provider:null,model:null,keySource:null,configurationWarning:null,usedToday:0,
  remainingToday:12,dailyRequestLimit:12,maxOutputTokens:512,lastRequestAt:null,
};
type Entry={id:number;question:string;answer:AIAnswer};
const projectAuditNames:Record<AIProjectAuditEvent["kind"],string>={
  "project.created":"创建项目","project.renamed":"修改项目资料","project.archived":"归档项目",
  "source.grant.updated":"更新资料授权","source.grant.revoked":"撤销资料授权",
  "action.grant.updated":"更新动作授权","source.access":"来源授权检查",
  "action.access":"动作授权检查",
};

function describeError(error:unknown):string{
  return error instanceof Error?error.message:"AI 服务未完成本次操作";
}

/** No automatic network calls: this page only asks on explicit confirmation. */
export default function AIWorkspace(){
  const [status,setStatus]=useState<AIStatus>(empty);
  const [apiKey,setApiKey]=useState("");
  const [model,setModel]=useState(AI_DEFAULT_MODEL);
  const [provider,setProvider]=useState<AIProvider>("openai");
  const [endpoint,setEndpoint]=useState("");
  const [question,setQuestion]=useState("");
  const [preview,setPreview]=useState<AIPreview|null>(null);
  const [answers,setAnswers]=useState<Entry[]>([]);
  const [busy,setBusy]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [tasks,setTasks]=useState<LocalTask[]>([]);
  const [projects,setProjects]=useState<AIProject[]>([]);
  const [activeProjectId,setActiveProjectId]=useState("");
  const [projectGrants,setProjectGrants]=useState<AIProjectSourceGrant[]>([]);
  const [projectActions,setProjectActions]=useState<AIProjectActionGrant[]>([]);
  const [projectAudit,setProjectAudit]=useState<AIProjectAuditEvent[]>([]);
  const [newProjectName,setNewProjectName]=useState("");
  const [newProjectPurpose,setNewProjectPurpose]=useState("");
  const [editProjectName,setEditProjectName]=useState("");
  const [editProjectPurpose,setEditProjectPurpose]=useState("");
  const [grantDuration,setGrantDuration]=useState<"1d"|"7d"|"30d"|"never">("7d");
  const [chosen,setChosen]=useState<string[]>([]);
  const [planStart,setPlanStart]=useState(()=>new Date().toLocaleDateString("en-CA"));
  const [previewMode,setPreviewMode]=useState<"chat"|"plan">("chat");
  const [planDraft,setPlanDraft]=useState<AIPlanSuggestion[]|null>(null);
  const [planNames,setPlanNames]=useState<Record<string,string>>({});


  const activeProject=projects.find(item=>item.id===activeProjectId&&!item.archivedAt)??null;
  const planningAction=projectActions.find(item=>item.action==="planning.propose");
  function expiryFromDuration():string|null{
    const duration=grantDuration==="1d"?86_400_000:
      grantDuration==="7d"?7*86_400_000:
      grantDuration==="30d"?30*86_400_000:0;
    return duration?new Date(Date.now()+duration).toISOString():null;
  }
  async function reloadProjectDetails(id:string):Promise<void>{
    const [grants,actions,audit]=await Promise.all([
      window.desktop.ai.projects.sourceGrants(id),
      window.desktop.ai.projects.actionGrants(id),
      window.desktop.ai.projects.audit(id),
    ]);
    if(id===activeProjectId){
      setProjectGrants(grants);setProjectActions(actions);setProjectAudit(audit);
    }
  }

  useEffect(()=>{
    let active=true;
    void window.desktop.ai.status().then(next=>{
      if(active){setStatus(next);if(next.model)setModel(next.model);
        if(next.provider)setProvider(next.provider);}
    }).catch(e=>{if(active)setError(describeError(e));});
    void window.desktop.tasks.list().then(value=>{if(active)setTasks(value);})
      .catch(e=>{if(active)setError(describeError(e));});
    void window.desktop.ai.projects.list().then(value=>{
      if(!active)return;
      setProjects(value);
      const first=value.find(item=>!item.archivedAt);
      if(first)setActiveProjectId(first.id);
    }).catch(e=>{if(active)setError(describeError(e));});
    return()=>{active=false;};
  },[]);

  useEffect(()=>{
    let active=true;
    if(!activeProjectId){
      setProjectGrants([]);setProjectActions([]);setProjectAudit([]);
      return()=>{active=false;};
    }
    const project=projects.find(item=>item.id===activeProjectId);
    if(project){setEditProjectName(project.name);setEditProjectPurpose(project.purpose);}
    void Promise.all([
      window.desktop.ai.projects.sourceGrants(activeProjectId),
      window.desktop.ai.projects.actionGrants(activeProjectId),
      window.desktop.ai.projects.audit(activeProjectId),
    ]).then(([grants,actions,audit])=>{
      if(active){setProjectGrants(grants);setProjectActions(actions);setProjectAudit(audit);}
    }).catch(e=>{if(active)setError(describeError(e));});
    return()=>{active=false;};
  },[activeProjectId,projects]);

  async function cancelActivePreview():Promise<void>{
    if(!preview)return;
    if(previewMode==="plan")await window.desktop.ai.planCancel();
    else setStatus(await window.desktop.ai.cancel());
    setPreview(null);
  }

  async function createProject(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      await cancelActivePreview();
      const created=await window.desktop.ai.projects.create({
        name:newProjectName,purpose:newProjectPurpose,
      });
      const next=await window.desktop.ai.projects.list();
      setProjects(next);setActiveProjectId(created.id);
      setNewProjectName("");setNewProjectPurpose("");
      setChosen([]);setPlanDraft(null);setPreview(null);
      setNotice("已创建仅保存在本机的 AI 项目空间。项目没有自动读取任何资料。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function saveProject():Promise<void>{
    if(!activeProject||busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      const saved=await window.desktop.ai.projects.rename({
        id:activeProject.id,name:editProjectName,purpose:editProjectPurpose,
      });
      setProjects(items=>items.map(item=>item.id===saved.id?saved:item));
      setNotice("项目名称和用途已保存。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function archiveProject():Promise<void>{
    if(!activeProject||busy||sending)return;
    if(!window.confirm("归档此 AI 项目？所有资料读取、云端发送和动作授权将立即撤销。审计记录会保留；不会删除原始任务。"))return;
    setBusy(true);setError("");setNotice("");
    try{
      await cancelActivePreview();
      await window.desktop.ai.projects.archive(activeProject.id);
      const next=await window.desktop.ai.projects.list();
      setProjects(next);setActiveProjectId(next.find(item=>!item.archivedAt)?.id??"");
      setChosen([]);setPlanDraft(null);setPreview(null);
      setNotice("项目已归档，所有项目授权已撤销；原始任务和日历数据未删除。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function switchProject(id:string):Promise<void>{
    if(id===activeProjectId)return;
    try{await cancelActivePreview();}catch(e){setError(describeError(e));return;}
    setPlanDraft(null);setChosen([]);
    setActiveProjectId(id);
  }

  async function setTaskPermission(taskId:string,permission:"local"|"remote",enabled:boolean):Promise<void>{
    if(!activeProject||busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      const current=projectGrants.find(item=>item.sourceType==="task"&&item.sourceId===taskId);
      const currentStillActive=!!current&&current.revokedAt===null&&
        (!current.expiresAt||Date.parse(current.expiresAt)>Date.now());
      const canReadLocal=permission==="local"?enabled:currentStillActive&&!!current?.canReadLocal;
      // Re-authorizing local access never silently restores an expired/revoked
      // cloud-transfer consent. That permission needs its own fresh click.
      const canSendRemote=permission==="remote"?enabled&&canReadLocal:
        (enabled&&currentStillActive?!!current?.canSendRemote:false);
      if(!canReadLocal&&!canSendRemote){
        await window.desktop.ai.projects.revokeSourceGrant({
          projectId:activeProject.id,sourceType:"task",sourceId:taskId,
        });
        setChosen(items=>items.filter(id=>id!==taskId));
      }else{
        await window.desktop.ai.projects.setSourceGrant({
          projectId:activeProject.id,sourceType:"task",sourceId:taskId,
          canReadLocal,canSendRemote,
          // Editing one permission must not silently extend another active grant.
          expiresAt:currentStillActive?current!.expiresAt:expiryFromDuration(),
        });
        if(!canSendRemote)setChosen(items=>items.filter(id=>id!==taskId));
      }
      if(preview&&previewMode==="plan")await cancelActivePreview();
      await reloadProjectDetails(activeProject.id);
      setNotice("项目资料授权已更新。读取权限与云端发送权限彼此独立；已有规划预览已取消，需要重新审查。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function setPlanningPermission(enabled:boolean):Promise<void>{
    if(!activeProject||busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      await window.desktop.ai.projects.setActionGrant({
        projectId:activeProject.id,action:"planning.propose",
        enabled,expiresAt:enabled?expiryFromDuration():null,
      });
      if(preview&&previewMode==="plan")await cancelActivePreview();
      await reloadProjectDetails(activeProject.id);
      if(!enabled){setChosen([]);setPlanDraft(null);}
      setNotice(enabled?"已允许此项目生成待审查的学习计划草稿。":"已撤销此项目生成学习计划草稿的权限。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function connect(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      const next=await window.desktop.ai.connect({
        apiKey,model,provider,endpoint:provider==="compatible"?endpoint:null,
      });
      setStatus(next);
      setPreview(null);
      setNotice("API Key 已加密保存在此设备，并优先于环境变量。尚未发起付费测试请求，密钥可用性将在首次确认提问时验证。");
    }catch(e){setError(describeError(e));}
    finally{setApiKey("");setBusy(false);}
  }

  async function disconnect():Promise<void>{
    if(!window.confirm("删除此设备加密保存的 API Key？如果 OPENAI_API_KEY 环境变量已设置，删除后会自动切换使用它；否则 AI 将断开。这不会撤销服务商中的 Key。"))return;
    if(busy||sending)return;
    setBusy(true);setError("");
    try{
      const next=await window.desktop.ai.disconnect();
      setStatus(next);
      setPreview(null);setQuestion("");setAnswers([]);setPlanDraft(null);
      setNotice(next.keySource==="environment"
        ?"本机加密 Key 已清除，当前已切换为 OPENAI_API_KEY 环境变量。每日请求次数不会重置。"
        :"本机加密 Key 已清除，AI 已断开。每日请求次数不会重置。");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function prepare(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy||sending||preview)return;
    setBusy(true);setError("");setNotice("");
    try{
      setPreview(await window.desktop.ai.prepare(question));
      setPreviewMode("chat");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function preparePlan():Promise<void>{
    if(busy||sending||preview)return;
    setBusy(true);setError("");setNotice("");setPlanDraft(null);
    try{
      if(!activeProjectId)throw Error("请先创建或选择一个 AI 项目空间");
      const latest=await window.desktop.tasks.list();
      setTasks(latest);
      const eligible=eligibleAIPlanTasks(latest,chosen);
      const grants=new Map(projectGrants.map(item=>[item.sourceId,item]));
      if(eligible.some(task=>!grants.get(task.id)?.canReadLocal||
        !grants.get(task.id)?.canSendRemote))
        throw Error("本次所选任务必须分别授予项目本地读取和云端模型发送权限");
      if(!projectActions.find(item=>item.action==="planning.propose"&&item.enabled))
        throw Error("请先单独允许此项目生成学习时间草稿");
      const next=await window.desktop.ai.planPrepare({
        projectId:activeProjectId,taskIds:chosen,
        settings:{startDate:planStart,days:7,dailyStart:"18:00",
          dailyEnd:"21:00",minutesPerTask:45},
      });
      setPlanNames(Object.fromEntries(eligible.map(t=>[t.id,t.title])));
      setPreview(next);setPreviewMode("plan");
      void reloadProjectDetails(activeProjectId).catch(e=>setError(describeError(e)));
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function discard():Promise<void>{
    if(sending)return;
    setBusy(true);
    try{
      if(previewMode==="plan")await window.desktop.ai.planCancel();
      else setStatus(await window.desktop.ai.cancel());
      setPreview(null);
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function confirm():Promise<void>{
    if(!preview||busy||sending)return;
    const accepted=preview;
    setSending(true);setError("");setNotice("");
    try{
      if(previewMode==="plan"){
        const acceptedPlan=await window.desktop.ai.planConfirm(accepted.approvalId);
        const result:AIPlanSuggestion[]=acceptedPlan.proposal.blocks.map(block=>{
          const hour=String(Math.floor(block.startMinute/60)).padStart(2,"0");
          const minute=String(block.startMinute%60).padStart(2,"0");
          return {taskId:block.taskId,day:block.day,start:hour+":"+minute,
            minutes:block.durationMinutes,reason:block.rationale};
        });
        setPlanDraft(result);
        setNotice("项目授权已在发送前复核；AI 草稿已通过主进程时间窗、截止日期和冲突校验，尚未应用到正式日历。");
      }else{
        const answer=await window.desktop.ai.confirm(accepted.approvalId);
        setAnswers(items=>[...items,{id:Date.now(),question:accepted.prompt,answer}].slice(-12));
        setQuestion("");
        setNotice("已收到本次单轮回答。回答未自动写入日历、任务、知识库或邮件。");
      }
    }catch(e){setError(describeError(e));}
    finally{
      setPreview(null);setSending(false);
      if(previewMode==="plan"&&activeProjectId)
        void reloadProjectDetails(activeProjectId).catch(e=>setError(describeError(e)));
      void window.desktop.ai.status().then(setStatus).catch(()=>{});
    }
  }

  async function cancelRequest():Promise<void>{
    try{
      setStatus(await window.desktop.ai.cancel());
      setPreview(null);setNotice("已尝试中止请求。服务商可能仍已处理或计费，请在平台核对用量；不会自动重试。");
    }catch(e){setError(describeError(e));}
  }

  return <section className="ai-page">
    <div className="page-heading">
      <div><div className="eyebrow">EXPLICIT AI PROVIDER</div>
        <h1>AI 学习助手 · 单轮问答</h1>
        <p>自行配置 AI 服务商与个人 API Key，预览并确认后才发送单次请求</p>
      </div>
      <span className="count-chip" role="status">{sending?"请求处理中":status.connected
        ?status.keySource==="environment"?"使用环境变量 API Key":"使用本机加密 API Key"
        :"尚未连接"}</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>付费与隐私告知</strong>
      每次确认后，你输入的问题将通过 HTTPS 发送给当前选择的 AI 服务商，并可能按该服务商的计价产生费用。
      每日最多 {status.dailyRequestLimit} 次请求、每次最多 {status.maxOutputTokens} 个输出 token；
      这是软件端限额，<strong>不是费用金额上限</strong>，其他设备和平台用量不受此限额控制。
      API 请求指定不保存响应供模型会话使用，但服务商仍会依其 API 数据处理政策处理请求。
      普通提问不会自动读取个人数据；项目规划必须先在本机项目空间逐项授权个人任务读取，再单独允许向云模型发送。主进程会在付费请求前复核授权并完整展示实际提示词，只发送所选个人任务的标题、截止日、优先级和标识，不发送描述、Canvas 链接、邮箱或知识库。模型不能调用工具或写入日历。
      请勿在聊天或 GitHub 中分享 API Key。
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    {status.configurationWarning==="invalid_environment_key"&&<div className="error-banner" role="alert">
      检测到环境变量 OPENAI_API_KEY，但格式无效。请检查变量值，或在下方手动输入有效的个人项目 Key。
    </div>}
    <div className="ai-layout">
      <section className="panel ai-model-panel">
        <div className="eyebrow">PERSONAL KEY / ENVIRONMENT</div>
        <h2>模型连接</h2>
        {status.connected&&<div className="ai-connection">
          <p>服务商：{status.provider==="openai"?"OpenAI":status.provider==="anthropic"?"Anthropic Claude":
            status.provider==="gemini"?"Google Gemini":status.provider==="deepseek"?"DeepSeek":"OpenAI-compatible 第三方接口"}</p>
          <p>已设置模型：<strong>{status.model}</strong></p>
          <p>Key 来源：<strong>{status.keySource==="environment"?"环境变量 OPENAI_API_KEY":"本机系统凭据加密存储"}</strong></p>
          {status.keySource==="environment"&&<p className="privacy-note">
            环境变量仅由 Electron 主进程读取，不会保存到应用凭据库或暴露给页面。
            如需停用，请在操作系统中移除该变量并重启应用。
          </p>}
          {status.keySource==="saved"&&<p className="privacy-note">
            本机保存的 Key 优先于环境变量。删除它后，如环境变量存在会自动切换使用环境变量。
          </p>}
          <p>当前 UTC 日请求：<strong>{status.usedToday}/{status.dailyRequestLimit}</strong></p>
          <p>剩余请求：<strong>{status.remainingToday}</strong></p>
          <p className="privacy-note">已配置不代表密钥或模型一定有效；第一次明确确认提问才会连接服务商。</p>
          {status.keySource==="saved"&&<button className="secondary-button" disabled={busy||sending}
            onClick={()=>void disconnect()}>删除本机保存的 Key</button>}
        </div>}
        <form className="ai-config-form" onSubmit={event=>void connect(event)}>
          <label>API 服务商
            <select value={provider} disabled={busy||sending} onChange={event=>{
              const next=event.target.value as AIProvider;
              setProvider(next);
              if(next!=="compatible")setModel(AI_MODEL_DEFAULTS[next]);
              else setModel("");
            }}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="gemini">Google Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="compatible">其他 OpenAI-compatible API</option>
            </select>
          </label>
          {provider==="compatible"&&<label>可信服务商的 HTTPS Chat Completions 完整地址
            <input value={endpoint} required maxLength={300} autoComplete="off"
              placeholder="https://api.example.com/v1/chat/completions"
              onChange={event=>setEndpoint(event.target.value)}/>
          </label>}
          <label>模型 ID（以你的服务商账号可调用的型号为准）
            <input value={model} required maxLength={68} autoComplete="off"
              onChange={event=>setModel(event.target.value)} placeholder="模型的完整 ID"/>
          </label>
          <label>手动输入个人项目 API Key（保存到本机安全凭据库）
            <input value={apiKey} required type="password" autoComplete="off"
              placeholder="sk-…" onChange={event=>setApiKey(event.target.value)}/>
          </label>
          <button type="submit" className="primary-button" disabled={busy||sending}>
            {status.connected?(status.keySource==="environment"?"保存并切换到手动 Key":"替换本地模型配置与 Key"):"加密保存配置（不进行付费测试）"}
          </button>
          <p className="privacy-note">
            OpenAI、Anthropic、Gemini、DeepSeek 使用厂商官方 API，其他服务商需提供兼容 Chat Completions 的 HTTPS 接口，
            不能保证任何专有 API Key 直接通用。确认调用前请审核实际服务商及提示词；
            第三方服务商的数据处理、计费规则由你选择的服务商决定。
            手动输入会使用系统凭据加密；如果安全加密不可用，会拒绝保存，不退回明文存储。
            也可用 <code>OPENAI_API_KEY</code>、<code>ANTHROPIC_API_KEY</code>、
            <code>GEMINI_API_KEY</code>、<code>DEEPSEEK_API_KEY</code>，或为其他兼容接口设置
            <code>STUDY_ANCHOR_AI_PROVIDER</code>、<code>STUDY_ANCHOR_AI_MODEL</code>、
            <code>STUDY_ANCHOR_AI_ENDPOINT</code>、<code>STUDY_ANCHOR_AI_API_KEY</code>。
            本机加密 Key 优先；删除本机 Key 后才会回退到环境变量。环境变量不写入应用数据库或凭据文件。
            兼容接口要求公网 HTTPS URL，不允许本地或内网地址。
          </p>
        </form>
      </section>

      <section className="panel ai-chat">
        <div className="eyebrow">APPROVED SINGLE REQUEST</div>
        <h2>单轮提问</h2>
        <p className="privacy-note">对话仅在当前页面内存中展示，关闭页面不会保留聊天记录；每次只发送本次明确确认的问题，不包含此前对话或其他模块数据。</p>
        {answers.length>0&&<div className="ai-answer-list">{answers.map(item=>
          <article className="ai-answer" key={item.id}>
            <div className="eyebrow">YOU ASKED</div><p>{item.question}</p>
            <div className="eyebrow">MODEL ANSWER · {item.answer.model}</div>
            <div className="ai-answer-text">{item.answer.text}</div>
            <small>输入 token：{item.answer.usage.inputTokens??"未提供"} · 输出 token：{item.answer.usage.outputTokens??"未提供"}</small>
          </article>
        )}</div>}
        {preview ? <div className="ai-preview" role="region" aria-label="付费 AI 请求确认">
          <strong className="review-stage-label">待确认 · 发送前最后核对</strong>
          <p>将向 <strong>{preview.endpointLabel}</strong>（{preview.provider}）发送以下文字，模型为 <strong>{preview.model}</strong>：</p>
          <div className="ai-question-preview">{preview.prompt}</div>
          <p className="privacy-note">单次输出最多 {preview.maxOutputTokens} token；确认有效至 {new Date(preview.expiresAt).toLocaleString("zh-CN")}。
            一次性确认后不能自动重试，可能产生计费。</p>
          <div className="button-row">
            <button className="primary-button" disabled={sending||busy}
              onClick={()=>void confirm()}>{sending?"正在请求…":"确认发送至所选 AI 服务商"}</button>
            <button className="secondary-button" disabled={sending||busy}
              onClick={()=>void discard()}>取消，继续编辑</button>
          </div>
        </div> : <form className="ai-config-form" onSubmit={event=>void prepare(event)}>
          <label>你要提交的具体问题
            <textarea rows={7} value={question} required maxLength={AI_MAX_PROMPT_CHARS}
              placeholder="例如：解释为什么导数可以表示瞬时变化率，并给一个直观例子。"
              onChange={event=>setQuestion(event.target.value)}/>
          </label>
          <div className="ai-char-count">{question.length}/{AI_MAX_PROMPT_CHARS} 字符</div>
          <button className="primary-button" type="submit"
            disabled={busy||sending||!status.connected||status.remainingToday===0}>
            预览外发内容（不产生 API 请求）
          </button>
        </form>}
        {sending&&<button className="secondary-button"
          onClick={()=>void cancelRequest()}>尝试中止当前请求（可能仍产生费用）</button>}
      </section>
    </div>
    <section className="panel ai-draft-panel">
      <div className="eyebrow">LOCAL AI PROJECTS · EXPLICIT PERMISSIONS</div>
      <h2>AI 项目空间与权限</h2>
      <p className="privacy-note">
        项目及授权记录仅保存在此设备，不会自动同步到团队空间。当前仅接入个人任务作为项目资料；
        知识库、邮箱、Canvas 和本地文件尚未接入此项目授权层。项目权限不会自动赋予 AI 写入、发信或使用外部工具的能力。
      </p>
      {projects.some(item=>!item.archivedAt)&&<div className="ai-config-form">
        <label>当前 AI 项目
          <select value={activeProjectId} disabled={busy||sending}
            onChange={event=>void switchProject(event.target.value)}>
            {projects.filter(item=>!item.archivedAt).map(item=>
              <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {activeProject&&<>
          <label>项目名称
            <input value={editProjectName} maxLength={80} disabled={busy||sending}
              onChange={event=>setEditProjectName(event.target.value)}/>
          </label>
          <label>项目目的
            <textarea rows={2} value={editProjectPurpose} maxLength={300} disabled={busy||sending}
              onChange={event=>setEditProjectPurpose(event.target.value)}/>
          </label>
          <div className="button-row">
            <button className="secondary-button" disabled={busy||sending}
              onClick={()=>void saveProject()}>保存项目资料</button>
            <button className="secondary-button" disabled={busy||sending}
              onClick={()=>void archiveProject()}>归档并撤销全部授权</button>
          </div>
          <label>新授权默认有效期
            <select value={grantDuration} disabled={busy||sending}
              onChange={event=>setGrantDuration(event.target.value as "1d"|"7d"|"30d"|"never")}>
              <option value="1d">1 天</option>
              <option value="7d">7 天</option>
              <option value="30d">30 天</option>
              <option value="never">持续有效，直到手动撤销</option>
            </select>
          </label>
          <div className="planner-select">
            <label>
              <input type="checkbox" checked={!!planningAction?.enabled}
                disabled={busy||sending||!planningAction?.available}
                onChange={event=>void setPlanningPermission(event.target.checked)}/>
              <span>允许 AI 在此项目生成学习计划草稿（只生成待审查建议，不写入正式日历）</span>
            </label>
          </div>
          {planningAction?.enabled&&planningAction.expiresAt&&
            <p className="privacy-note">规划草稿动作授权到期：{new Date(planningAction.expiresAt).toLocaleString("zh-CN")}</p>}
          <h3>项目资料访问权限</h3>
          <p className="privacy-note">
            本地读取与云端模型发送必须分别授权。发送前仍会完整预览实际提示词并要求你再次确认；
            撤销或过期的授权会在主进程阻止新请求。
          </p>
          <div className="planner-candidates ai-draft-candidates" aria-label="项目个人任务授权">
            {tasks.filter(task=>task.visible&&!task.completed&&task.source===null).slice(0,50).map(task=>{
              const grant=projectGrants.find(item=>item.sourceType==="task"&&item.sourceId===task.id);
              const local=!!grant?.canReadLocal&&grant.revokedAt===null&&
                (!grant.expiresAt||Date.parse(grant.expiresAt)>Date.now());
              const remote=local&&!!grant?.canSendRemote;
              return <div key={task.id} className="planner-select ai-project-resource">
                <strong>{task.title}</strong>
                <span>截止 {task.dueDate??"未设置"} · {task.priority}</span>
                <label>
                  <input type="checkbox" checked={local} disabled={busy||sending}
                    onChange={event=>void setTaskPermission(task.id,"local",event.target.checked)}/>
                  允许项目在本机读取此任务摘要
                </label>
                <label>
                  <input type="checkbox" checked={remote} disabled={busy||sending||!local}
                    onChange={event=>void setTaskPermission(task.id,"remote",event.target.checked)}/>
                  允许将此任务标题、截止日期和优先级发送给当前云端模型
                </label>
                <label>
                  <input type="checkbox" checked={chosen.includes(task.id)}
                    disabled={busy||sending||!!preview||!local||!remote||!planningAction?.enabled}
                    onChange={event=>setChosen(items=>event.target.checked
                      ?items.length<8?[...items,task.id]:items
                      :items.filter(id=>id!==task.id))}/>
                  选入本次学习计划请求
                </label>
                {grant?.expiresAt&&<small>授权到期：{new Date(grant.expiresAt).toLocaleString("zh-CN")}</small>}
              </div>;
            })}
            {!tasks.some(task=>task.visible&&!task.completed&&task.source===null)&&<p>当前没有可授权的个人任务。</p>}
          </div>
          <p className="privacy-note">项目已授权 {projectGrants.filter(item=>item.canReadLocal&&item.revokedAt===null&&
            (!item.expiresAt||Date.parse(item.expiresAt)>Date.now())).length} 项任务；
            已选择 {chosen.length}/8 项用于本次规划。任务描述、Canvas 链接和其他任务不会发送。</p>
          <h3>尚未开放的高影响动作（默认拒绝）</h3>
          <div className="planner-candidates">
            {projectActions.filter(action=>action.action!=="planning.propose").map(action=><label key={action.action} className="planner-select">
              <input type="checkbox" checked={action.enabled}
                disabled={!action.available||busy||sending}
                onChange={event=>void setPlanningPermission(event.target.checked)}/>
              <span>{action.action} · {action.available?"当前支持：仅生成规划草稿":"尚未实现，保持禁止"}</span>
            </label>)}
          </div>
          <p className="privacy-note">
            修改任务、写入日历、发送邮件、写入文件和调用外部工具目前没有执行器，即使未来出现模型请求也会被拒绝。
            规划草稿不会自动应用。
          </p>
          <h3>最近权限审计</h3>
          {projectAudit.length===0?<p className="privacy-note">尚无授权或访问记录。</p>:
            <ul>{projectAudit.slice(0,8).map(event=><li key={event.id}>
              {projectAuditNames[event.kind]} ·
              {event.result==="allowed"?"授权检查通过":event.result==="denied"?"授权检查拒绝":"已记录"} ·
              {event.destination==="cloud-model"?"云端模型":event.destination==="local"?"本机":"本地操作"} ·
              {new Date(event.occurredAt).toLocaleString("zh-CN")}
            </li>)}</ul>}
        </>}
      </div>}
      <form className="ai-config-form" onSubmit={event=>void createProject(event)}>
        <h3>新建个人 AI 项目</h3>
        <label>项目名称
          <input value={newProjectName} required maxLength={80} disabled={busy||sending}
            placeholder="例如：微积分期末复习"
            onChange={event=>setNewProjectName(event.target.value)}/>
        </label>
        <label>项目目的（可选）
          <textarea rows={2} value={newProjectPurpose} maxLength={300} disabled={busy||sending}
            placeholder="描述这个项目要完成的工作"
            onChange={event=>setNewProjectPurpose(event.target.value)}/>
        </label>
        <button className="primary-button" type="submit" disabled={busy||sending}>
          创建本机 AI 项目空间
        </button>
      </form>
    </section>
    <section className="panel ai-draft-panel">
      <div className="eyebrow">OPT-IN STRUCTURED PLANNING DRAFT</div>
      <h2>AI 学习时间草稿（不自动应用）</h2>
      <p className="privacy-note">只选择你愿意外传的任务。预览会完整展示实际发送内容；AI 结果只做格式与范围验证，不作为已确认时间块，也不自动查询课表。请不要勾选包含敏感信息的标题。</p>
      <label>建议开始日期（连续七天）
        <input type="date" value={planStart} min={new Date().toLocaleDateString("en-CA")}
          disabled={busy||sending||!!preview} onChange={event=>setPlanStart(event.target.value)}/>
      </label>
      <p className="privacy-note">当前项目：{activeProject?.name??"未选择"} · 已选 {chosen.length}/8 项。
        只有分别授予本地读取和云端发送权限的任务才可加入本次请求。</p>
      <button className="primary-button" disabled={busy||sending||!!preview||!status.connected||
        status.remainingToday===0||!activeProject||!planningAction?.enabled||chosen.length===0}
        onClick={()=>void preparePlan()}>预览项目授权范围内的 AI 规划请求</button>
      {planDraft!==null&&<div className="ai-answer-list ai-draft-result" role="region" aria-label="AI 学习草稿">
        <h3>待人工核对的 AI 建议 · {planDraft.length} 段</h3>
        {planDraft.length===0?<p>模型未安排任何时间块。</p>:
          <ul>{planDraft.map((block,i)=><li key={i}>
            <strong>{planNames[block.taskId]}</strong> · {block.day} {block.start} · {block.minutes} 分钟
            <p>{block.reason}</p>
          </li>)}</ul>}
        <p className="privacy-note">当前仅供阅读，不会静默创建任务、修改截止日期或写入计划；使用现有离线学习规划界面执行已验证的选择性应用流程。</p>
      </div>}
    </section>
  </section>;
}
