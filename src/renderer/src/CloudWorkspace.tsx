import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  CloudSessionStatus, SharedMember, SharedMessage, SharedTask, SharedWorkspace,
} from "../../shared/cloud-model";

const empty:CloudSessionStatus={configured:false,authenticated:false,userId:null,email:null};
const POLL_MS=10_000;
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

  useEffect(()=>{
    let active=true;
    void window.desktop.cloud.status().then(next=>{if(active)setStatus(next);})
      .catch(reason=>{if(active)setError(issue(reason));});
    return()=>{active=false;};
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
