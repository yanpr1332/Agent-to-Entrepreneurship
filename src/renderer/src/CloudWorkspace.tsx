import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  CloudSessionStatus, SharedMember, SharedMessage, SharedTask, SharedWorkspace,
} from "../../shared/cloud-model";
import type {
  PersonalSyncCandidate, PersonalSyncConflictRecord, PersonalSyncConflictReason, PersonalSyncRunResult,
  PersonalSyncResolutionRequest, PersonalSyncLegacyReview, PersonalSyncLegacyAdoptionRequest,
} from "../../shared/personal-sync-contract";

const empty:CloudSessionStatus={configured:false,authenticated:false,userId:null,email:null};
const POLL_MS=10_000;
const conflictReason:Record<PersonalSyncConflictReason,string>={
  "remote-change-while-local-pending":"本地修改尚未上传，云端也有新修改",
  "remote-delete-while-local-pending":"本地修改尚未上传，但云端已删除",
  "local-entity-not-eligible":"本机同 ID 记录不属于可同步的个人数据",
  "remote-overlaps-study-plan":"云端课程与本机已确认学习计划冲突",
  "local-calendar-capacity":"本机日历容量已满",
};

function syncSnapshotDetail(payload:PersonalSyncConflictRecord["localPayload"]):string {
  if(!payload)return "无记录内容";
  if("dueDate" in payload)
    return "截止："+(payload.dueDate??"未设置")+" · 优先级："+payload.priority+
      " · "+(payload.completed?"已完成":"未完成")+
      (payload.description?" · 描述："+payload.description:"");
  return "日期："+payload.day+" · 开始："+String(Math.floor(payload.startMinute/60)).padStart(2,"0")+
    ":"+String(payload.startMinute%60).padStart(2,"0")+
    " · "+payload.durationMinutes+" 分钟";
}

function issue(error:unknown):string{return error instanceof Error?error.message:"云端操作未完成";}
function timestamp(value:string):string {
  const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString("zh-CN"):value;
}

/**
 * Cloud data remains separate from local SQLite/Canvas/mail.
 * All calls use the signed-in user's JWT through Electron Main.
 */
export default function CloudWorkspace() {
  const [status,setStatus]=useState<CloudSessionStatus>(empty);
  const [projectUrl,setProjectUrl]=useState("");
  const [publishableKey,setPublishableKey]=useState("");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [workspaceName,setWorkspaceName]=useState("");
  const [displayName,setDisplayName]=useState("");
  const [joinCode,setJoinCode]=useState("");
  const [workspaces,setWorkspaces]=useState<SharedWorkspace[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [members,setMembers]=useState<SharedMember[]>([]);
  const [messages,setMessages]=useState<SharedMessage[]>([]);
  const [tasks,setTasks]=useState<SharedTask[]>([]);
  const [text,setText]=useState("");
  const [taskTitle,setTaskTitle]=useState("");
  const [taskDue,setTaskDue]=useState("");
  const [taskAssignee,setTaskAssignee]=useState("");
  const [invite,setInvite]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [personalCandidates,setPersonalCandidates]=useState<PersonalSyncCandidate[]>([]);
  const [personalConflicts,setPersonalConflicts]=useState<PersonalSyncConflictRecord[]>([]);
  const [personalSyncResult,setPersonalSyncResult]=useState<PersonalSyncRunResult|null>(null);
  const [resolutionReview,setResolutionReview]=useState<PersonalSyncResolutionRequest|null>(null);
  const [legacyReview,setLegacyReview]=useState<PersonalSyncLegacyReview>({
    items:[],taskLimitReached:false,calendarLimitReached:false,
  });
  const [legacySelection,setLegacySelection]=useState<PersonalSyncLegacyAdoptionRequest|null>(null);

  useEffect(()=>{
    let active=true;
    void window.desktop.cloud.status().then(next=>{if(active)setStatus(next);})
      .catch(reason=>{if(active)setError(issue(reason));});
    return()=>{active=false;};
  },[]);

  const refreshPersonalSync=useCallback(async()=>{
    const [candidates,conflicts,legacy]=await Promise.all([
      window.desktop.cloud.personalSyncCandidates(),
      window.desktop.cloud.personalSyncConflicts(),
      window.desktop.cloud.personalSyncLegacyReview(),
    ]);
    setPersonalCandidates(candidates);
    setPersonalConflicts(conflicts);
    setLegacyReview(legacy);
  },[]);

  const refreshSelected=useCallback(async (workspaceId:string)=>{
    const [remoteMembers,remoteMessages,remoteTasks]=await Promise.all([
      window.desktop.cloud.members(workspaceId),
      window.desktop.cloud.messages(workspaceId),
      window.desktop.cloud.tasks(workspaceId),
    ]);
    setMembers(remoteMembers);
    setMessages(remoteMessages);
    setTasks(remoteTasks);
  },[]);

  useEffect(()=>{
    if(!status.authenticated){
      setPersonalCandidates([]);
      setPersonalConflicts([]);
      setPersonalSyncResult(null);
      setResolutionReview(null);
      setLegacyReview({items:[],taskLimitReached:false,calendarLimitReached:false});
      setLegacySelection(null);
      return;
    }
    let active=true;
    void refreshPersonalSync().catch(reason=>{if(active)setError(issue(reason));});
    return()=>{active=false;};
  },[status.authenticated,refreshPersonalSync]);

  useEffect(()=>{
    if(!status.authenticated || !selected)return;
    let active=true;
    const poll=()=>{
      void Promise.all([
        window.desktop.cloud.messages(selected),
        window.desktop.cloud.tasks(selected),
      ]).then(([msg,t])=>{if(active){setMessages(msg);setTasks(t);}})
        .catch(()=>{}); // Poll failures do not erase existing shared state.
    };
    const timer=setInterval(poll,POLL_MS);
    return()=>{active=false;clearInterval(timer);};
  },[status.authenticated,selected]);

  async function run(operation:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");
    try{await operation();}
    catch(reason){setError(issue(reason));}
    finally{setBusy(false);}
  }

  async function configure(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      const next=await window.desktop.cloud.configure({projectUrl,publishableKey});
      setStatus(next);
      setPublishableKey("");
      setNotice("已使用公开的测试项目配置。登录账号后才能读取共享内容。");
    });
  }

  async function authenticate(signup:boolean):Promise<void>{
    await run(async()=>{
      const credentials={email,password};
      if(signup){
        await window.desktop.cloud.signup(credentials);
        setNotice("已提交注册请求。若邮箱验证已开启，请先完成邮件验证再登录。");
      }else{
        const next=await window.desktop.cloud.login(credentials);
        setStatus(next);
        setNotice("已使用独立云账号登录。");
        await refreshPersonalSync();
        const available=await window.desktop.cloud.workspaces();
        setWorkspaces(available);
      }
      setPassword("");
    });
    setPassword("");
  }

  async function logout():Promise<void>{
    await run(async()=>{
      const next=await window.desktop.cloud.logout();
      setStatus(next);setWorkspaces([]);setSelected(null);
      setMembers([]);setMessages([]);setTasks([]);setInvite("");
      setPersonalCandidates([]);setPersonalConflicts([]);setPersonalSyncResult(null);
      setLegacyReview({items:[],taskLimitReached:false,calendarLimitReached:false});
      setLegacySelection(null);setResolutionReview(null);
      setNotice("已退出云端账号；个人本地任务与其他连接器不受影响。");
    });
  }

  async function enterWorkspace(id:string):Promise<void>{
    await run(async()=>{
      setSelected(id);setInvite("");
      await refreshSelected(id);
    });
  }

  async function createWorkspace(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      const id=await window.desktop.cloud.createWorkspace(workspaceName,displayName);
      setWorkspaces(await window.desktop.cloud.workspaces());
      setSelected(id);setWorkspaceName("");
      await refreshSelected(id);
      setNotice("测试工作空间已创建。你可以生成一次性显示的邀请码邀请其他独立账号。");
    });
  }

  async function joinWorkspace(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      const id=await window.desktop.cloud.joinWorkspace(joinCode.trim(),displayName);
      setWorkspaces(await window.desktop.cloud.workspaces());
      setSelected(id);setJoinCode("");
      await refreshSelected(id);
      setNotice("已加入工作空间，服务端将按成员身份判断数据访问权限。");
    });
  }

  async function makeInvite():Promise<void>{
    if(!selected)return;
    await run(async()=>{
      const code=await window.desktop.cloud.createInvite(selected);
      setInvite(code);
      setNotice("此邀请码 48 小时内有效，最多还能用于 4 人加入。只分享给要邀请的成员。");
    });
  }

  async function syncPersonalNow():Promise<void>{
    await run(async()=>{
      const result=await window.desktop.cloud.syncPersonalNow();
      setPersonalSyncResult(result);
      await refreshPersonalSync();
      setNotice(result.pushDeferred?"检测到尚未拉取的云端变更：本轮先拉取，没有上传待发送修改。请检查冲突后再次手动同步。":"个人数据同步流程已完成；本地待发送队列和冲突状态已刷新。");
    });
  }

  async function setPersonalSyncEnabled(item:PersonalSyncCandidate,enabled:boolean):Promise<void>{
    await run(async()=>{
      if(item.entityType==="personal-task")
        await window.desktop.cloud.setPersonalTaskSync(item.entityId,enabled);
      else
        await window.desktop.cloud.setManualEventSync(item.entityId,enabled);
      await refreshPersonalSync();
      setNotice(enabled?"已授权此条目同步到当前云账号。":"已停止此条目的后续同步；云端已有副本不会因此删除。");
    });
  }

  async function adoptLegacyItem():Promise<void>{
    if(!legacySelection)return;
    const request=legacySelection;
    await run(async()=>{
      await window.desktop.cloud.adoptPersonalSyncLegacy(request);
      setLegacySelection(null);
      setPersonalSyncResult(null);
      await refreshPersonalSync();
      setNotice("已将选定的历史记录重新授权给当前账号，仅在本机生成新的待发送快照。没有上传旧内容；如需上传请另外点击“立即同步”。");
    });
  }

  async function resolvePersonalConflict():Promise<void>{
    if(!resolutionReview)return;
    const reviewed=resolutionReview;
    await run(async()=>{
      await window.desktop.cloud.resolvePersonalSyncConflict(reviewed);
      setResolutionReview(null);
      setPersonalSyncResult(null);
      await refreshPersonalSync();
      setNotice(reviewed.choice==="keep-local"
        ?"已保留本机内容，并将操作基线更新为所审阅的云端版本。请再次手动同步以提交；若云端此时发生新变化，会再次提示冲突。"
        :"已采用所审阅的云端内容；本机的原待发送操作已取消。");
    });
  }

  async function sendMessage(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(!selected)return;
    await run(async()=>{
      await window.desktop.cloud.sendMessage(selected,text);
      setText("");
      await refreshSelected(selected);
    });
  }

  async function createTask(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(!selected)return;
    await run(async()=>{
      await window.desktop.cloud.createTask(selected,{
        title:taskTitle,dueDate:taskDue||null,assignedTo:taskAssignee||null,
      });
      setTaskTitle("");setTaskDue("");setTaskAssignee("");
      await refreshSelected(selected);
    });
  }

  async function toggleTask(item:SharedTask):Promise<void>{
    if(!selected)return;
    await run(async()=>{
      await window.desktop.cloud.markTask(selected,item.id,!item.completed);
      await refreshSelected(selected);
    });
  }

  const active=workspaces.find(item=>item.id===selected);
  const owner=members.some(member=>member.user_id===status.userId && member.role==="owner");

  return <section className="cloud-page">
    <div className="page-heading">
      <div><div className="eyebrow">FIVE-PERSON CLOUD POC</div>
        <h1>云端小组协作</h1>
        <p>独立账号、受服务端 RLS 保护的共享任务与消息（当前为 Supabase 测试方案）</p>
      </div><span className="count-chip">{status.authenticated ? status.email : "尚未登录"}</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>请只连接你自己有权限管理的隔离测试项目。</strong>
      使用公开的 Supabase Publishable/Anon Key，不要填写 service_role、数据库密码或团队成员的密码。
      个人日历、Canvas 凭据、交大邮箱数据不会自动上传到云端。
      当前消息每 10 秒刷新一次，属于轮询而非 Supabase Realtime 推送。
    </div>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={()=>setError("")}>关闭</button></div>}
    {notice && <div className="connector-notice" role="status">{notice}</div>}

    {!status.configured && <section className="panel cloud-setup">
      <div className="eyebrow">PROJECT CONFIGURATION</div><h2>连接 Supabase 测试项目</h2>
      <form className="cloud-form" onSubmit={event=>void configure(event)}>
        <label>项目 URL<input type="url" value={projectUrl} required
          placeholder="https://example.supabase.co" onChange={event=>setProjectUrl(event.target.value)} /></label>
        <label>Publishable / Anon 公共客户端密钥<input type="password" value={publishableKey}
          required autoComplete="off" placeholder="sb_publishable_...（禁止 service_role）"
          onChange={event=>setPublishableKey(event.target.value)} /></label>
        <button className="primary-button" disabled={busy}>保存本次测试项目配置</button>
      </form>
      <p className="privacy-note">必须由项目所有者先在测试 Supabase 的 SQL Editor 中执行仓库提供的 RLS 迁移。应用不会自行创建数据库或部署外部服务。</p>
    </section>}

    {status.configured && !status.authenticated && <section className="panel cloud-auth">
      <div className="eyebrow">INDIVIDUAL AUTHENTICATION</div><h2>使用本人独立账号</h2>
      <form className="cloud-form" onSubmit={event=>{event.preventDefault();void authenticate(false);}}>
        <label>邮箱<input type="email" value={email} required maxLength={254}
          onChange={event=>setEmail(event.target.value)} /></label>
        <label>密码<input type="password" value={password} required minLength={8}
          maxLength={256} autoComplete="off" onChange={event=>setPassword(event.target.value)} /></label>
        <div className="button-row">
          <button className="primary-button" type="submit" disabled={busy}>登录云端账号</button>
          <button className="secondary-button" type="button" disabled={busy}
            onClick={()=>void authenticate(true)}>
            注册新账号
          </button>
        </div>
      </form>
      <p className="privacy-note">登录会话仅保存在本次 Electron 主进程内存，关闭程序后需重新登录。注册账号可能需要验证电子邮件。</p>
    </section>}

    {status.authenticated && <>
      <div className="cloud-session-row">
        <span>当前登录：{status.email}</span>
        <button className="secondary-button" disabled={busy} onClick={()=>void logout()}>退出云端账号</button>
      </div>
      <section className="panel cloud-personal-sync">
        <div className="panel-heading">
          <div><div className="eyebrow">PERSONAL DEVICE SYNC · MANUAL</div><h2>个人任务与手动日历同步</h2></div>
          <button className="primary-button" disabled={busy} onClick={()=>void syncPersonalNow()}>
            {busy?"正在处理…":"立即同步"}
          </button>
        </div>
        <p className="privacy-note">
          只有下方逐条勾选的个人任务和手动课程会同步到当前账号。Canvas、ICS、邮件、知识库、专注记录和学习计划不会上传。
          同步仅在点击按钮时运行，不会后台自动上传。取消勾选不会删除云端已有副本。
        </p>
        {personalSyncResult && <div className="connector-notice" role="status">
          上传 {personalSyncResult.pushed} 项 · 拉取 {personalSyncResult.pulled} 项 ·
          待发送 {personalSyncResult.pending} 项 · 冲突 {personalSyncResult.conflicts} 项
          {personalSyncResult.pushConflicts ? " · 服务端版本冲突 "+personalSyncResult.pushConflicts+" 项" : ""}
          {personalSyncResult.rejected ? " · 被拒绝 "+personalSyncResult.rejected+" 项" : ""}
          {personalSyncResult.retryableFailures ? " · 可重试失败 "+personalSyncResult.retryableFailures+" 项" : ""}
          {personalSyncResult.hasMore ? " · 还有更多变更待拉取" : ""}
          {personalSyncResult.pushDeferred ? " · 本轮因云端存在新变更已暂缓上传" : ""}
        </div>}
        <div className="cloud-sync-candidates">
          <h3>逐条选择同步内容</h3>
          {personalCandidates.length===0 ? <p className="empty-state">当前没有可授权的个人任务或手动课程。</p> :
            personalCandidates.map(item=><label className="cloud-sync-candidate" key={item.entityType+":"+item.entityId}>
              <input type="checkbox" checked={item.enabled} disabled={busy}
                onChange={event=>void setPersonalSyncEnabled(item,event.target.checked)} />
              <span><strong>{item.title}</strong><small>{item.entityType==="personal-task"?"个人任务":"手动课程"}
                {item.detail ? " · "+item.detail : ""}</small></span>
            </label>)}
        </div>
        {legacyReview.items.length>0 && <section className="cloud-sync-legacy" aria-label="历史同步数据隔离区">
          <h3>历史同步记录隔离区（{legacyReview.items.length} 项）</h3>
          <p className="privacy-note">这些记录来自旧版没有账号归属的同步队列，并不代表属于当前登录账号。
            它们不会自动上传，也不会自动执行旧删除操作。只有仍存在、来源允许的任务或手动课程，
            才能逐条重新授权；重新授权使用<strong>本机当前内容</strong>生成新待发送操作，
            旧 payload、旧云端版本和旧 operationId 一律不会继承。</p>
          {(legacyReview.taskLimitReached||legacyReview.calendarLimitReached)&&
            <p className="privacy-note">当前每个本地数据库最多显示前 100 条；部分历史记录仍未显示，也不会自动处理。</p>}
          <div className="cloud-sync-legacy-list">
            {legacyReview.items.map(item=>{
              const actionLabel=item.action==="delete"?"历史删除墓碑":
                item.action==="enrolled"?"旧版同步授权":"历史待上传修改";
              const key=item.legacyStore+":"+item.entityId+":"+(item.operationId??"enrollment");
              const eligible=item.canReauthorize&&
                (item.action==="upsert"||item.action==="enrolled")&&
                ((item.entityType==="personal-task"&&item.legacyStore==="task-database")||
                 (item.entityType==="manual-calendar-event"&&item.legacyStore==="calendar-database"));
              const chosen=legacySelection?.entityType===item.entityType&&
                legacySelection?.entityId===item.entityId&&
                legacySelection?.expectedAction===item.action&&
                legacySelection?.expectedOperationId===item.operationId;
              return <article className="cloud-sync-legacy-item" key={key}>
                <strong>{item.title??"本机内容已不存在"}</strong>
                <small>{item.entityType==="personal-task"?"个人任务":"手动日历"} · {actionLabel}
                  {" · "}{timestamp(item.createdAt)}</small>
                <small>本地记录 ID：{item.entityId}</small>
                {eligible?<>
                  <button type="button" className="secondary-button" disabled={busy}
                    onClick={()=>setLegacySelection({entityType:item.entityType,
                      entityId:item.entityId,expectedAction:item.action as "upsert"|"enrolled",
                      expectedOperationId:item.operationId,confirmation:true})}>检查并重新授权</button>
                  {chosen&&legacySelection&&<div className="cloud-sync-confirm" role="group"
                    aria-label="确认历史同步记录重新授权">
                    <p><strong>确认绑定到当前登录账号 {status.email??"未知账号"}？</strong>
                      这会将当前本机记录加入此账号的新待发送队列。旧版数据无法证明原本属于此账号；
                      如果有重复记录或不同账号版本，后续上传可能发生冲突。此操作不会立即上传。</p>
                    <div className="button-row">
                      <button type="button" className="primary-button" disabled={busy}
                        onClick={()=>void adoptLegacyItem()}>确认重新授权该条目</button>
                      <button type="button" className="secondary-button" disabled={busy}
                        onClick={()=>setLegacySelection(null)}>取消</button>
                    </div>
                  </div>}
                </>:<p className="privacy-note">保持隔离：历史删除、来源不明或本机已不存在的记录，
                  不支持重新授权或远端删除；本轮仅供查看，不会清除记录。</p>}
              </article>;
            })}
          </div>
        </section>}
        {personalConflicts.length>0 && <div className="cloud-sync-conflicts">
          <h3>需要人工处理的同步冲突（{personalSyncResult?.conflicts??personalConflicts.length}）</h3>
          <p className="privacy-note">冲突会阻止该条目的自动上传或远端覆盖。请检查两份内容，明确选择一方。
            “采用云端”可能覆盖或删除本地记录；操作前会再次读取云端增量并校验版本，冲突版本变化时必须重新审阅。
            {personalSyncResult && personalSyncResult.conflicts>personalConflicts.length ? " 当前仅展示最新 100 条。" : ""}</p>
          {personalConflicts.map(item=>{
            const canResolve=item.canResolve===true&&Boolean(item.localOperationId);
            const reviewed=resolutionReview?.entityType===item.entityType&&
              resolutionReview.entityId===item.entityId&&
              resolutionReview.remoteVersion===item.remoteVersion&&
              resolutionReview.localOperationId===item.localOperationId;
            return <article className="cloud-sync-conflict" key={item.entityType+":"+item.entityId}>
              <strong>{item.localPayload?.title??item.remotePayload?.title??item.entityId}</strong>
              <small>{item.entityType==="personal-task"?"个人任务":"手动课程"} · 云端版本 {item.remoteVersion} · {conflictReason[item.reason]}</small>
              <div className="cloud-sync-version"><strong>本机版本</strong>
                <p>{item.localAction==="delete"?"已删除":item.localPayload?.title??"本机记录待检查"}</p>
                <p>{item.localAction==="delete"?"本机提出删除":syncSnapshotDetail(item.localPayload)}</p>
              </div>
              <div className="cloud-sync-version"><strong>云端版本</strong>
                <p>{item.remoteDeleted?"已删除":item.remotePayload?.title??"云端内容不可用"}</p>
                <p>{item.remoteDeleted?"采用云端将删除本机对应内容":syncSnapshotDetail(item.remotePayload)}</p>
              </div>
              {canResolve?<div className="cloud-sync-resolution">
                <div className="button-row">
                  <button type="button" className="secondary-button" disabled={busy}
                    onClick={()=>setResolutionReview({entityType:item.entityType,
                      entityId:item.entityId,remoteVersion:item.remoteVersion,
                      localOperationId:item.localOperationId!,choice:"keep-local"})}>保留本机</button>
                  <button type="button" className="secondary-button" disabled={busy}
                    onClick={()=>setResolutionReview({entityType:item.entityType,
                      entityId:item.entityId,remoteVersion:item.remoteVersion,
                      localOperationId:item.localOperationId!,choice:"use-remote"})}>采用云端</button>
                </div>
                {reviewed&&resolutionReview&&<div className="cloud-sync-confirm" role="group"
                  aria-label="确认同步冲突解决">
                  <p><strong>待确认：{resolutionReview.choice==="keep-local"?"保留本机":"采用云端"}</strong>
                    {resolutionReview.choice==="use-remote"
                      ? "。本机内容可能被覆盖或删除，且此操作不可在本界面撤销。"
                      : "。将以当前云端版本重新提交本机操作；并非立即完成上传。"}
                    请再次确认。</p>
                  <div className="button-row">
                    <button className="primary-button" disabled={busy}
                      onClick={()=>void resolvePersonalConflict()}>确认这个选择</button>
                    <button className="secondary-button" disabled={busy}
                      onClick={()=>setResolutionReview(null)}>取消</button>
                  </div>
                </div>}
              </div>:<p className="privacy-note">此冲突涉及来源权限、日历容量、学习计划或已变更的授权，暂不可自动裁决；
                请先检查本机数据或重新同步，不会擅自覆盖。</p>}
            </article>;
          })}
        </div>}
      </section>
      <div className="cloud-layout">
        <section className="panel cloud-workspaces">
          <div className="eyebrow">SHARED WORKSPACES</div><h2>我的小组</h2>
          {workspaces.length ? <div className="cloud-workspace-list">
            {workspaces.map(item=><button key={item.id}
              className={selected===item.id ? "chip selected" : "chip"}
              onClick={()=>void enterWorkspace(item.id)}>{item.name}</button>)}
          </div> : <p className="empty-state">尚未加入工作空间。创建一个小组或使用邀请码加入。</p>}
          <form className="cloud-form" onSubmit={event=>void createWorkspace(event)}>
            <h3>创建新小组</h3>
            <label>小组名称<input required value={workspaceName} maxLength={120}
              onChange={event=>setWorkspaceName(event.target.value)} /></label>
            <label>本人显示名称<input required value={displayName} maxLength={60}
              onChange={event=>setDisplayName(event.target.value)} /></label>
            <button className="secondary-button" disabled={busy}>创建（最多 5 人）</button>
          </form>
          <form className="cloud-form" onSubmit={event=>void joinWorkspace(event)}>
            <h3>使用邀请码加入</h3>
            <label>48 位邀请码<input required value={joinCode} maxLength={48} autoComplete="off"
              onChange={event=>setJoinCode(event.target.value)} /></label>
            <button className="secondary-button" disabled={busy}>加入小组</button>
          </form>
        </section>

        <section className="cloud-main">
          {!selected ? <div className="panel"><p className="empty-state">选择左侧工作空间查看消息和共享任务。</p></div> : <>
            <section className="panel">
              <div className="panel-heading"><div><div className="eyebrow">MEMBERSHIP</div><h2>{active?.name??"工作空间"} · 成员</h2></div>
                <span className="muted-tag">{members.length}/5</span></div>
              <div className="cloud-members">{members.map(member=><span className="chip" key={member.user_id}>
                {member.display_name} {member.role==="owner"?"· 所有者":""}
              </span>)}</div>
              {owner && <div className="cloud-invite">
                <button className="secondary-button" disabled={busy} onClick={()=>void makeInvite()}>生成邀请码</button>
                {invite && <div className="cloud-invite-secret" role="status"><strong>仅显示本次生成的邀请码：</strong>
                  <code>{invite}</code><small>最多 4 人、48 小时有效。请私下分享，不要发布到公开仓库。</small></div>}
              </div>}
            </section>
            <section className="panel cloud-chat">
              <div className="eyebrow">TEAM MESSAGES</div><h2>小组消息 · 每 10 秒刷新</h2>
              <ul className="cloud-message-list">{[...messages].reverse().map(item=><li key={item.id}>
                <div><strong>{members.find(m=>m.user_id===item.author_id)?.display_name??"成员"}</strong>
                  <small>{timestamp(item.created_at)}</small></div>
                <p>{item.body}</p></li>)}</ul>
              {!messages.length && <p className="empty-state">暂无消息，发送第一条小组消息。</p>}
              <form className="cloud-message-form" onSubmit={event=>void sendMessage(event)}>
                <textarea rows={3} required maxLength={2000} placeholder="输入小组消息（最多 2000 字）"
                  value={text} onChange={event=>setText(event.target.value)} />
                <button className="primary-button" disabled={busy}>发送消息</button>
              </form>
            </section>
            <section className="panel cloud-shared-tasks">
              <div className="eyebrow">SHARED TASKS</div><h2>小组共享任务</h2>
              {tasks.length ? <ul className="cloud-task-list">{tasks.map(item=><li key={item.id}>
                <input type="checkbox" checked={item.completed} disabled={busy}
                  onChange={()=>void toggleTask(item)} aria-label={`完成共享任务：${item.title}`} />
                <div><strong className={item.completed?"done":""}>{item.title}</strong>
                  <small>{item.due_date??"未设置截止日期"} · {members.find(m=>m.user_id===item.assigned_to)?.display_name??"未分配"}</small></div>
              </li>)}</ul> : <p className="empty-state">暂无共享任务；个人日历任务不会自动复制到这里。</p>}
              <form className="cloud-form" onSubmit={event=>void createTask(event)}>
                <label>共享任务标题<input value={taskTitle} required maxLength={120}
                  onChange={event=>setTaskTitle(event.target.value)} /></label>
                <label>截止日期<input type="date" value={taskDue} onChange={event=>setTaskDue(event.target.value)} /></label>
                <label>分配给谁<select value={taskAssignee} onChange={event=>setTaskAssignee(event.target.value)}>
                  <option value="">暂不分配</option>
                  {members.map(member=><option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}
                </select></label>
                <button className="primary-button" disabled={busy}>创建共享任务</button>
              </form>
            </section>
          </>}
        </section>
      </div>
    </>}
  </section>;
}
