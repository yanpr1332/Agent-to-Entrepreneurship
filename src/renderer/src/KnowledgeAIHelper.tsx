import {useEffect,useState,type FormEvent} from "react";
import type {AIPreview,AIAnswer,AIStatus} from "../../shared/ai-model";
import type {KnowledgePassage} from "../../shared/knowledge-model";
import {buildKnowledgeAIPrompt,KNOWLEDGE_AI_MAX_QUESTION_CHARS} from "../../shared/knowledge-ai-prompt";

function errorMessage(error:unknown):string{
  return error instanceof Error?error.message:"AI 请求未完成";
}

/** Only an explicitly selected, revision-stamped passage can be offered to AI.
 * No API call occurs on mount except status (which does not send user data).
 */
export default function KnowledgeAIHelper({passage}:{passage:KnowledgePassage}){
  const [status,setStatus]=useState<AIStatus|null>(null);
  const [question,setQuestion]=useState("");
  const [pending,setPending]=useState<AIPreview|null>(null);
  const [response,setResponse]=useState<AIAnswer|null>(null);
  const [busy,setBusy]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const [note,setNote]=useState("");
  const [citation,setCitation]=useState<{
    title:string;revision:number;ordinal:number;page:number|null;excerpt:string;truncated:boolean;
  }|null>(null);

  useEffect(()=>{
    let active=true;
    void window.desktop.ai.status().then(next=>{
      if(active)setStatus(next);
    }).catch(reason=>{if(active)setError(errorMessage(reason));});
    return ()=>{active=false;};
  },[]);

  async function refresh():Promise<void>{
    try{setStatus(await window.desktop.ai.status());}
    catch(reason){setError(errorMessage(reason));}
  }

  async function prepare(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy||sending||pending)return;
    setBusy(true);setError("");setNote("");setResponse(null);
    try{
      const prepared=buildKnowledgeAIPrompt(question,passage);
      const intent=await window.desktop.ai.prepare(prepared.prompt);
      setCitation({
        title:passage.documentTitle,revision:passage.revision,ordinal:passage.ordinal,
        page:passage.pageNumber,excerpt:prepared.excerpt,truncated:prepared.truncated,
      });
      setPending(intent);
    }catch(reason){setError(errorMessage(reason));}
    finally{setBusy(false);}
  }

  async function discard():Promise<void>{
    if(sending||busy||!pending)return;
    setBusy(true);setError("");
    try{
      setStatus(await window.desktop.ai.cancel());
      setPending(null);setCitation(null);
      setNote("已取消，选中的原文没有被发送。");
    }catch(reason){setError(errorMessage(reason));}
    finally{setBusy(false);}
  }

  async function confirm():Promise<void>{
    if(!pending||sending||busy)return;
    const approved=pending;
    setSending(true);setError("");setNote("");
    try{
      const answer=await window.desktop.ai.confirm(approved.approvalId);
      setResponse(answer);
      setNote("仅显示模型参考回答，不会自动修改复习卡或知识库。请对照下方本机原文核验。");
    }catch(reason){setError(errorMessage(reason));}
    finally{
      setPending(null);
      setSending(false);
      await refresh();
    }
  }

  async function cancelSending():Promise<void>{
    if(!sending)return;
    try{
      setStatus(await window.desktop.ai.cancel());
      setPending(null);
      setNote("已尝试取消。请求可能已经到达服务商并产生费用，请勿自动重试。");
    }catch(reason){setError(errorMessage(reason));}
  }

  return <section className="kb-ai-helper">
    <div className="eyebrow">OPTIONAL · EXPLICIT SOURCE-ASSISTED AI</div>
    <h3>使用 AI 辅助解释这一段原文</h3>
    <p className="privacy-note">
      默认仅本地阅读。只有你先选择提问、检查将发送的完整文字，再点击确认后，
      才会向 OpenAI API 发送**当前一段**原文和你的问题；不发送文件路径、其他段落、
      日历、Canvas 或邮箱。可能计费；模型回答不等于已经验证的引用或事实。
    </p>
    {!status?<p className="help-text">正在读取本机 AI 连接状态…</p>:
      !status.connected?<p className="help-text">
        尚未连接 AI。可在左侧「AI 助手」配置自己的 API Key，回来后点击
        「刷新连接状态」；不连接也能完整使用离线知识库。
      </p>:<p className="help-text">
        模型：{status.model} · 今日可用请求 {status.remainingToday}/{status.dailyRequestLimit}
      </p>}
    <div className="button-row">
      <button type="button" className="small-button" disabled={sending||busy}
        onClick={()=>void refresh()}>刷新连接状态</button>
    </div>
    <form onSubmit={event=>void prepare(event)} className="kb-ai-question-form">
      <label>只针对当前原文片段提问
        <textarea rows={2} required maxLength={KNOWLEDGE_AI_MAX_QUESTION_CHARS}
          value={question} onChange={event=>setQuestion(event.target.value)}
          placeholder="例如：用简单语言解释这段内容，哪些结论有原文支持？"
          disabled={busy||sending||!!pending}/>
      </label>
      <button className="secondary-button" type="submit"
        disabled={busy||sending||!!pending||!status?.connected||
          status.remainingToday===0||!question.trim()}>
        第一步：预览将发送的资料
      </button>
    </form>
    {pending&&<div className="ai-preview" role="region" aria-label="知识库 AI 单次上传确认">
      <strong>第二步：明确确认发送</strong>
      <p>下列内容将发送给 OpenAI API，模型为 <strong>{pending.model}</strong>：</p>
      <pre className="ai-question-preview">{pending.prompt}</pre>
      <p className="privacy-note">引用源：{citation?.title} · 第 {citation?.revision} 版 ·
        片段 #{(citation?.ordinal??0)+1}{citation?.page?" · PDF 第 "+citation.page+" 页":""}。
        {citation?.truncated?"仅发送片段前 1150 字符。":""}
        确认后可能产生费用，最多输出 {pending.maxOutputTokens} token，
        不会自动重试；确认有效至 {new Date(pending.expiresAt).toLocaleString("zh-CN")}。
      </p>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy||sending}
          onClick={()=>void confirm()}>确认发送这段原文</button>
        <button type="button" className="secondary-button" disabled={busy||sending}
          onClick={()=>void discard()}>取消，不发送</button>
      </div>
    </div>}
    {sending&&<button type="button" className="secondary-button"
      onClick={()=>void cancelSending()}>尝试取消正在进行的请求</button>}
    {response&&citation&&<article className="kb-ai-answer" aria-label="AI 辅助解释与本机原文来源">
      <div className="eyebrow">MODEL OUTPUT · {response.model}</div>
      <div className="ai-answer-text">{response.text}</div>
      <p className="privacy-note">本机原文依据：{citation.title} · 第 {citation.revision} 版 ·
        片段 #{citation.ordinal+1}{citation.page?" · PDF 第 "+citation.page+" 页":""}。
        以下是本次明确选择的来源，不代表模型已核验回答：</p>
      <pre className="kb-ai-source-evidence">{citation.excerpt}</pre>
      <small>输入 token：{response.usage.inputTokens??"服务商未提供"} · 输出 token：
        {response.usage.outputTokens??"服务商未提供"}</small>
    </article>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    {note&&<p className="privacy-note" role="status">{note}</p>}
  </section>;
}
