import { useEffect, useState, type FormEvent } from "react";
import type { MailRecord, MailSendPreview, MailSyncState } from "../../shared/mail-model";

const initial: MailSyncState = {
  connected:false,email:null,running:false,lastAttempt:null,
  lastSuccess:null,lastError:null,messageCount:0,
};
function message(error:unknown):string {
  return error instanceof Error ? error.message : "操作失败，请检查邮箱服务器或授权设置";
}
function date(value:string|null):string {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚无记录";
}

/** Personal mail headers stay in local SQLite; sending always needs confirmation. */
export default function CampusMail() {
  const [status,setStatus] = useState<MailSyncState>(initial);
  const [messages,setMessages] = useState<MailRecord[]>([]);
  const [email,setEmail] = useState("");
  const [username,setUsername] = useState("");
  const [password,setPassword] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [recipientText,setRecipientText] = useState("");
  const [subject,setSubject] = useState("");
  const [body,setBody] = useState("");
  const [preview,setPreview] = useState<MailSendPreview|null>(null);

  useEffect(() => {
    let active=true;
    const update=() => {
      void Promise.all([window.desktop.mail.status(),window.desktop.mail.list()])
        .then(([next,list]) => {
          if (!active) return;
          setStatus(next);
          setMessages(list);
        }).catch(reason => { if (active) setError(message(reason)); });
    };
    const unsubscribe=window.desktop.mail.onSyncUpdated(update);
    update();
    return () => {active=false;unsubscribe();};
  },[]);

  async function connect(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if (busy) return;
    setBusy(true);setError("");setNotice("");
    try {
      const connected=await window.desktop.mail.connect({email,username,password});
      setStatus(connected);
      setMessages(await window.desktop.mail.list());
      setNotice("已连接交大邮箱并读取收件箱邮件头。今后运行期间将定时自动同步。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPassword(""); // Never retain credentials in the renderer after a request.
      setBusy(false);
    }
  }

  async function synchronize():Promise<void>{
    if (busy) return;
    setBusy(true);setError("");setNotice("");
    try {
      const result=await window.desktop.mail.syncNow();
      setStatus(result);
      setMessages(await window.desktop.mail.list());
      setNotice(result.lastError || `收件箱同步完成，目前有 ${result.messageCount} 条本地邮件头记录。`);
    } catch(reason) {setError(message(reason));}
    finally {setBusy(false);}
  }

  async function disconnect():Promise<void>{
    if (!window.confirm("断开交大邮箱并删除本机加密凭据及同步的邮件头缓存？此操作不会删除服务器上的邮件。")) return;
    setBusy(true);setError("");setPreview(null);
    try {
      await window.desktop.mail.disconnect();
      setStatus(initial);setMessages([]);setEmail("");setUsername("");setPassword("");
      setNotice("已删除本机邮箱凭据和邮件头缓存；学校邮箱中的邮件未发生改变。");
    } catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }

  async function prepare(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if (busy || preview) return;
    setBusy(true);setError("");setNotice("");
    try {
      const to=recipientText.split(/[;,]/).map(value=>value.trim()).filter(Boolean);
      const response=await window.desktop.mail.prepareSend({to,subject,body});
      setPreview(response);
    } catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }

  async function confirm():Promise<void>{
    if (!preview || busy) return;
    const question=`确认立即发送给 ${preview.to.join("、")} 吗？发送后无法撤回。`;
    if (!window.confirm(question)) return;
    setBusy(true);setError("");setNotice("");
    try {
      await window.desktop.mail.confirmSend(preview.confirmationId);
      setPreview(null);setRecipientText("");setSubject("");setBody("");
      setNotice("SMTP 服务器已确认接受邮件。发送行为仅发生在这次明确确认之后。");
    } catch(reason){
      setPreview(null);
      setError(message(reason));
    } finally{setBusy(false);}
  }

  return (
    <section className="mail-page">
      <div className="page-heading">
        <div><div className="eyebrow">CAMPUS IMAP / SMTP</div><h1>交大邮箱</h1>
          <p>只读同步收件箱元数据 · 写草稿 · 核对后单次确认发送</p></div>
        <span className="count-chip">{status.connected ? `已连接 · ${status.email}` : "尚未连接"}</span>
      </div>
      <div className="connector-warning" role="note">
        <strong>隐私与发送控制</strong>
        收件箱每 10 分钟自动同步最近邮件的发件人、主题与日期，保存在此设备。
        当前不下载正文或附件，也不自动把邮件转成任务。密码使用系统安全加密保存；
        发送邮件必须先预览完整内容，再由你手动点击「确认发送」。
        请勿在聊天或 GitHub 中提交邮箱密码。
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={()=>setError("")}>关闭</button></div>}
      {notice && <div className="connector-notice" role="status">{notice}</div>}
      <div className="mail-layout">
        <section className="panel mail-connection">
          <div className="eyebrow">SECURE CONNECTION</div><h2>邮箱连接</h2>
          {status.connected ? (
            <>
              <p className="connector-host">{status.email}</p>
              <p className="help-text">IMAP: mail.sjtu.edu.cn:993 (TLS)</p>
              <p className="help-text">SMTP: mail.sjtu.edu.cn:465 (TLS)</p>
              <div className="runtime-line"><span>上次成功同步</span><strong>{date(status.lastSuccess)}</strong></div>
              <div className="runtime-line"><span>本地邮件头记录</span><strong>{status.messageCount}</strong></div>
              {status.lastError && <p className="error-message">{status.lastError}</p>}
              <div className="button-row">
                <button className="secondary-button" disabled={busy || status.running} onClick={()=>void synchronize()}>
                  {busy || status.running ? "同步中…" : "立即同步收件箱"}
                </button>
                <button className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>断开并清理本地缓存</button>
              </div>
            </>
          ) : (
            <form className="mail-form" onSubmit={(event)=>void connect(event)}>
              <label>交大邮箱地址<input type="email" value={email} required maxLength={254}
                placeholder="jaccount@sjtu.edu.cn" onChange={event=>setEmail(event.target.value)} /></label>
              <label>jAccount 登录用户名<input type="text" value={username} required maxLength={128}
                placeholder="jAccount 用户名" autoComplete="username"
                onChange={event=>setUsername(event.target.value)} /></label>
              <label>邮箱密码或官方客户端授权码<input type="password" value={password} required maxLength={1024}
                autoComplete="off" onChange={event=>setPassword(event.target.value)} /></label>
              <button className="primary-button full-width" type="submit" disabled={busy}>
                {busy ? "正在验证 IMAP…" : "验证并连接邮箱"}
              </button>
              <p className="privacy-note">不支持交大医学院独立云邮箱端点；首版仅使用交大网络信息中心公布的校级邮箱服务器。系统加密不可用时拒绝保存密码。</p>
            </form>
          )}
        </section>
        <section className="panel mail-inbox">
          <div className="eyebrow">LOCAL INBOX HEADERS</div>
          <div className="panel-heading"><h2>最近收件</h2><span className="muted-tag">{messages.length} 条</span></div>
          {messages.length ? (
            <ul className="mail-list">{messages.map(item=><li key={`${item.account}:${item.uidValidity}:${item.uid}`}>
              <strong>{item.subject}</strong>
              <div className="mail-meta"><span>发件人：{item.from}</span>
                <span>{date(item.date)}</span></div>
              {/作业|截止|报名|deadline|assignment|meeting|提交/i.test(item.subject) &&
                <small className="mail-candidate">可能包含待办事项 · 尚未自动创建任务</small>}
            </li>)}</ul>
          ) : <p className="empty-state">{status.connected ? "暂无最近的收件箱邮件头。" : "连接后在这里查看你邮箱中最近的邮件元数据。"}</p>}
          <p className="privacy-note">仅 INBOX，最多保留 200 条邮件头；不自动下载正文、附件、其他文件夹，也不会标记服务器邮件已读。</p>
        </section>
      </div>
      {status.connected && <section className="panel mail-compose">
        <div className="eyebrow">CONFIRMED SEND ONLY</div><h2>撰写并发送纯文本邮件</h2>
        {preview ? (
          <div className="mail-preview" role="region" aria-label="邮件发送确认预览">
            <p><strong>发件人：</strong>{preview.from}</p>
            <p><strong>收件人：</strong>{preview.to.join("、")}</p>
            <p><strong>主题：</strong>{preview.subject}</p>
            <div className="mail-preview-body">{preview.body}</div>
            <p className="privacy-note">此次确认有效至 {date(preview.expiresAt)}，且只能使用一次。请仔细核对所有收件人和内容。</p>
            <div className="button-row">
              <button className="primary-button" disabled={busy} onClick={()=>void confirm()}>
                {busy ? "正在发送…" : "确认发送这封邮件"}
              </button>
              <button className="secondary-button" disabled={busy} onClick={()=>setPreview(null)}>取消，返回编辑</button>
            </div>
          </div>
        ) : (
          <form className="mail-form" onSubmit={(event)=>void prepare(event)}>
            <label>收件人（最多 5 个，用英文逗号分隔）<input type="text" value={recipientText}
              required placeholder="person@sjtu.edu.cn" onChange={event=>setRecipientText(event.target.value)} /></label>
            <label>主题<input type="text" value={subject} required maxLength={180}
              onChange={event=>setSubject(event.target.value)} /></label>
            <label>正文<textarea rows={8} value={body} required maxLength={10000}
              onChange={event=>setBody(event.target.value)} /></label>
            <button className="primary-button" disabled={busy} type="submit">预览并请求发送确认</button>
            <p className="privacy-note">当前支持纯文本邮件；不支持附件、HTML、抄送或自动群发。SMTP 发送没有自动重试，出现不确定投递结果时先在学校邮箱「已发送」中核对。</p>
          </form>
        )}
      </section>}
    </section>
  );
}
