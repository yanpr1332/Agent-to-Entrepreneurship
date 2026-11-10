import { useEffect,useState,type FormEvent } from "react";
import {
  AI_DEFAULT_MODEL, AI_MAX_PROMPT_CHARS,
  type AIAnswer, type AIPreview, type AIStatus,
} from "../../shared/ai-model";
import type { LocalTask } from "../../shared/local-model";
import { eligibleAIPlanTasks, buildAIPlanPrompt, parseAIPlanDraft, type AIPlanSuggestion } from "../../shared/ai-planning";

const empty:AIStatus={
  connected:false,running:false,provider:"openai",model:null,usedToday:0,
  remainingToday:12,dailyRequestLimit:12,maxOutputTokens:512,lastRequestAt:null,
};
type Entry={id:number;question:string;answer:AIAnswer};

function describeError(error:unknown):string{
  return error instanceof Error?error.message:"AI 服务未完成本次操作";
}

/** No automatic network calls: this page only asks on explicit confirmation. */
export default function AIWorkspace(){
  const [status,setStatus]=useState<AIStatus>(empty);
  const [apiKey,setApiKey]=useState("");
  const [model,setModel]=useState(AI_DEFAULT_MODEL);
  const [question,setQuestion]=useState("");
  const [preview,setPreview]=useState<AIPreview|null>(null);
  const [answers,setAnswers]=useState<Entry[]>([]);
  const [busy,setBusy]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [tasks,setTasks]=useState<LocalTask[]>([]);
  const [chosen,setChosen]=useState<string[]>([]);
  const [planStart,setPlanStart]=useState(()=>new Date().toLocaleDateString("en-CA"));
  const [previewMode,setPreviewMode]=useState<"chat"|"plan">("chat");
  const [planDraft,setPlanDraft]=useState<AIPlanSuggestion[]|null>(null);
  const [planNames,setPlanNames]=useState<Record<string,string>>({});
  const [planSnapshot,setPlanSnapshot]=useState<LocalTask[]>([]);

  useEffect(()=>{
    let active=true;
    void window.desktop.ai.status().then(next=>{
      if(active){setStatus(next);if(next.model)setModel(next.model);}
    }).catch(e=>{if(active)setError(describeError(e));});
    void window.desktop.tasks.list().then(value=>{if(active)setTasks(value);})
      .catch(e=>{if(active)setError(describeError(e));});
    return()=>{active=false;};
  },[]);

  async function connect(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(busy||sending)return;
    setBusy(true);setError("");setNotice("");
    try{
      const next=await window.desktop.ai.connect({apiKey,model});
      setStatus(next);
      setPreview(null);
      setNotice("API Key 已加密保存在此设备。尚未发起付费测试请求，密钥可用性将在首次确认提问时验证。");
    }catch(e){setError(describeError(e));}
    finally{setApiKey("");setBusy(false);}
  }

  async function disconnect():Promise<void>{
    if(!window.confirm("断开 OpenAI API 连接并删除此设备的加密 Key？这不会撤销平台中的 Key；如需彻底吊销，请到服务商控制台处理。"))return;
    if(busy||sending)return;
    setBusy(true);setError("");
    try{
      setStatus(await window.desktop.ai.disconnect());
      setPreview(null);setQuestion("");setAnswers([]);setPlanDraft(null);
      setNotice("本地加密 Key 已清除。已使用的每日请求次数不会重置。");
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
      const latest=await window.desktop.tasks.list();
      setTasks(latest);
      const eligible=eligibleAIPlanTasks(latest,chosen);
      const prompt=buildAIPlanPrompt(latest,chosen,planStart);
      const next=await window.desktop.ai.prepare(prompt);
      setPlanSnapshot(eligible);
      setPlanNames(Object.fromEntries(eligible.map(t=>[t.id,t.title])));
      setPreview(next);setPreviewMode("plan");
    }catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function discard():Promise<void>{
    if(sending)return;
    setBusy(true);
    try{setStatus(await window.desktop.ai.cancel());setPreview(null);}
    catch(e){setError(describeError(e));}
    finally{setBusy(false);}
  }

  async function confirm():Promise<void>{
    if(!preview||busy||sending)return;
    const accepted=preview;
    setSending(true);setError("");setNotice("");
    try{
      const answer=await window.desktop.ai.confirm(accepted.approvalId);
      if(previewMode==="plan"){
        try{
          const result=parseAIPlanDraft(answer.text,planSnapshot,planStart);
          setPlanDraft(result);
          setNotice("AI 结构化建议已通过格式和范围验证；仅供参考，尚未写入正式任务或日历。");
        }catch(e){
          setPlanDraft(null);
          setError(describeError(e));
        }
      }else{
        setAnswers(items=>[...items,{id:Date.now(),question:accepted.prompt,answer}].slice(-12));
        setQuestion("");
        setNotice("已收到本次单轮回答。回答未自动写入日历、任务、知识库或邮件。");
      }
    }catch(e){setError(describeError(e));}
    finally{
      setPreview(null);setSending(false);
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
        <p>自己配置 OpenAI API Key，先预览，再明确确认后发送单次问题</p>
      </div>
      <span className="count-chip">{status.connected?"已保存个人 API Key":"尚未连接"}</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>付费与隐私告知</strong>
      每次确认后，你输入的问题将通过 HTTPS 发送给 OpenAI API，并可能按服务商当前计价产生费用。
      每日最多 {status.dailyRequestLimit} 次请求、每次最多 {status.maxOutputTokens} 个输出 token；
      这是软件端限额，<strong>不是费用金额上限</strong>，其他设备和平台用量不受此限额控制。
      API 请求指定不保存响应供模型会话使用，但服务商仍会依其 API 数据处理政策处理请求。
      普通提问不会自动读取个人数据；下方规划功能仅在你逐项勾选任务并确认原文后，才会发送所选任务的标题、截止日、优先级和标识，不发送描述、Canvas 链接、邮箱或知识库。模型不能调用工具或写入日历。
      请勿在聊天或 GitHub 中分享 API Key。
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <div className="ai-layout">
      <section className="panel">
        <div className="eyebrow">LOCAL KEY STORAGE</div>
        <h2>模型连接</h2>
        {status.connected&&<div className="ai-connection">
          <p>服务商：OpenAI Responses API</p>
          <p>已设置模型：<strong>{status.model}</strong></p>
          <p>当前 UTC 日请求：<strong>{status.usedToday}/{status.dailyRequestLimit}</strong></p>
          <p>剩余请求：<strong>{status.remainingToday}</strong></p>
          <p className="privacy-note">已保存不代表密钥或模型一定有效；第一次明确确认提问才会连接服务商。</p>
          <button className="secondary-button" disabled={busy||sending}
            onClick={()=>void disconnect()}>断开并删除本机 Key</button>
        </div>}
        <form className="ai-config-form" onSubmit={event=>void connect(event)}>
          <label>模型标识（GPT 系列）
            <input value={model} required maxLength={68} autoComplete="off"
              onChange={event=>setModel(event.target.value)} placeholder="gpt-4.1-mini"/>
          </label>
          <label>个人项目 API Key
            <input value={apiKey} required type="password" autoComplete="off"
              placeholder="sk-…" onChange={event=>setApiKey(event.target.value)}/>
          </label>
          <button type="submit" className="primary-button" disabled={busy||sending}>
            {status.connected?"替换本地模型配置与 Key":"加密保存配置（不进行付费测试）"}
          </button>
          <p className="privacy-note">只使用系统凭据加密；如果安全加密不可用，会拒绝保存，不退回明文存储。当前仅支持固定 OpenAI 官方 API 端点，不支持自定义 URL。</p>
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
          <strong>发送前最后核对</strong>
          <p>将向 <strong>OpenAI</strong> 发送以下文字，模型为 <strong>{preview.model}</strong>：</p>
          <div className="ai-question-preview">{preview.prompt}</div>
          <p className="privacy-note">单次输出最多 {preview.maxOutputTokens} token；确认有效至 {new Date(preview.expiresAt).toLocaleString("zh-CN")}。
            一次性确认后不能自动重试，可能产生计费。</p>
          <div className="button-row">
            <button className="primary-button" disabled={sending||busy}
              onClick={()=>void confirm()}>{sending?"正在请求…":"确认发送至 OpenAI API"}</button>
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
    <section className="panel">
      <div className="eyebrow">OPT-IN STRUCTURED PLANNING DRAFT</div>
      <h2>AI 学习时间草稿（不自动应用）</h2>
      <p className="privacy-note">只选择你愿意外传的任务。预览会完整展示实际发送内容；AI 结果只做格式与范围验证，不作为已确认时间块，也不自动查询课表。请不要勾选包含敏感信息的标题。</p>
      <label>建议开始日期（连续七天）
        <input type="date" value={planStart} min={new Date().toLocaleDateString("en-CA")}
          disabled={busy||sending||!!preview} onChange={event=>setPlanStart(event.target.value)}/>
      </label>
      <div className="planner-candidates">
        {tasks.filter(t=>t.visible&&!t.completed).slice(0,50).map(task=>
          <label key={task.id} className="planner-select">
            <input type="checkbox" disabled={busy||sending||!!preview}
              checked={chosen.includes(task.id)}
              onChange={event=>setChosen(v=>event.target.checked
                ? v.length<8?[...v,task.id]:v : v.filter(id=>id!==task.id))}/>
            <span>{task.title} · 截止 {task.dueDate??"未设置"} · {task.priority}</span>
          </label>
        )}
      </div>
      <p className="privacy-note">已选 {chosen.length}/8 项；隐藏或完成的任务不可选择，任务描述和来源 URL 不会发送。</p>
      <button className="primary-button" disabled={busy||sending||!!preview||!status.connected||status.remainingToday===0||chosen.length===0}
        onClick={()=>void preparePlan()}>预览选中任务的 AI 规划请求</button>
      {planDraft!==null&&<div className="ai-answer-list" role="region" aria-label="AI 学习草稿">
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
