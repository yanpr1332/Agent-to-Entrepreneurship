import {useEffect,useState} from "react";
import type {MailRecord} from "../../shared/mail-model";
import type {AIPreview} from "../../shared/ai-model";
import {mailAIKey,type MailAIRef,type MailAIReview} from "../../shared/mail-ai";

type Props={messages:MailRecord[]};
type Draft={title:string;dueDate:string};
function reason(error:unknown):string{
  return error instanceof Error?error.message:"邮件 AI 本次操作未完成";
}
const kindLabel={
  coursework:"课程/作业",deadline:"可能的截止事项",
  event:"活动/会议",none:"未发现可靠待办",
} as const;

/** Explicitly selected headers or individually selected messages' consented plain text.
 * Attachments, HTML, and other messages never enter the preview. */
export default function MailAIReviewPanel({messages}:Props){
  const [configured,setConfigured]=useState(false);
  const [chosen,setChosen]=useState<MailAIRef[]>([]);
  const [includeBodies,setIncludeBodies]=useState(false);
  const [preview,setPreview]=useState<AIPreview|null>(null);
  const [review,setReview]=useState<MailAIReview|null>(null);
  const [edits,setEdits]=useState<Record<string,Draft>>({});
  const [accepted,setAccepted]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    let mounted=true;
    void window.desktop.ai.status().then(value=>{
      if(mounted)setConfigured(value.connected);
    }).catch(e=>{if(mounted)setError(reason(e));});
    return()=>{mounted=false;};
  },[]);
  function select(item:MailRecord,checked:boolean):void{
    if(preview||review)return;
    const key=mailAIKey(item);
    if(checked){
      if(chosen.length>=3){setError("每次最多选择 3 封邮件的基本信息");return;}
      setChosen(previous=>previous.some(x=>mailAIKey(x)===key)?previous:
        [...previous,{uid:item.uid,uidValidity:item.uidValidity}]);
    }else setChosen(previous=>previous.filter(x=>mailAIKey(x)!==key));
    setError("");setNotice("");
  }
  async function prepare():Promise<void>{
    if(!chosen.length||busy)return;
    setBusy(true);setError("");setNotice("");setReview(null);
    try{
      if(includeBodies){
        const titles=chosen.map(ref=>messages.find(x=>mailAIKey(x)===mailAIKey(ref))?.subject)
          .filter(Boolean).join("\n• ");
        if(!window.confirm("仅本次读取下列已选邮件的纯文本正文（每封截取最多 1100 字符）。"+
          "不会读取附件或 HTML，不保存正文；下一步还会显示实际外发文本，需再次确认才发送给所选 AI 服务商。"+
          "\n• "+titles+"\n确认本次授权读取正文？"))return;
      }
      setPreview(await window.desktop.mail.aiPrepare({sources:chosen,includeBodies}));
    }catch(e){setError(reason(e));}
    finally{setBusy(false);}
  }
  async function confirm():Promise<void>{
    if(!preview||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await window.desktop.mail.aiConfirm(preview.approvalId);
      setReview(result);
      setEdits(Object.fromEntries(result.items.map(item=>[mailAIKey(item),{
        title:item.title,dueDate:item.dueDate??"",
      }])));
      setAccepted([]);
      setNotice("AI 结果仅作为待核对候选，没有创建任务。请核对标题、截止日期和来源后再决定。");
    }catch(e){setError(reason(e));}
    finally{setPreview(null);setBusy(false);}
  }
  async function cancel():Promise<void>{
    if(busy)return;
    setBusy(true);
    try{await window.desktop.mail.aiCancel();}
    catch(e){setError(reason(e));}
    finally{
      setPreview(null);setReview(null);setChosen([]);setIncludeBodies(false);setEdits({});
      setAccepted([]);setBusy(false);
    }
  }
  async function accept(item:MailAIReview["items"][number]):Promise<void>{
    if(!review||busy)return;
    const key=mailAIKey(item),value=edits[key];
    if(!value||!value.title.trim()){setError("请输入任务标题");return;}
    if(!window.confirm("确认把此邮件 AI 候选写入本机个人任务？\n"+
      "标题："+value.title+"\n截止日："+(value.dueDate||"不设置")+
      "\n不会给邮件回复、不会自动上传资料或修改服务端邮箱。"))return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await window.desktop.mail.aiApply({
        reviewId:review.reviewId,uid:item.uid,uidValidity:item.uidValidity,
        title:value.title,dueDate:value.dueDate||null,
      });
      setAccepted(values=>values.includes(key)?values:[...values,key]);
      setNotice(result.created?"已创建本机任务，可到日历继续编辑。":
        "此前已为此邮件创建过任务，未重复创建。");
    }catch(e){setError(reason(e));}
    finally{setBusy(false);}
  }
  return <section className="panel mail-ai-review" aria-label="邮件 AI 授权分析">
    <div className="eyebrow">OPTIONAL MAIL AI · TWO-STEP CONSENT</div>
    <h2>邮件 AI 识别 · 人工确认建任务</h2>
    <p className="privacy-note">
      默认只使用邮件基本信息，不会自动读取正文或附件。你最多选择 3 封当前已同步的邮件；
      选择“包含正文”并明确授权后，才会读取这几封邮件的纯文本正文（限长、不含附件或 HTML）。      所有待发送内容都先完整预览，再二次确认后发往所选 AI 服务商。
      这会使用你的个人 API Key 和当日请求额度，可能产生费用。邮件日期不是任务截止日期。
      AI 建议不会自动创建任务或发送邮件。
    </p>
    {!configured&&<p className="privacy-note" role="note">
      请在「AI 学习助手」选择服务商并保存个人 API Key，或在启动前设置相应服务商环境变量，随后返回分析。
      不需要也不允许把邮箱密码交给 AI。
    </p>}
    {error&&<p role="alert" className="error-banner">{error}</p>}
    {notice&&<p role="status" className="connector-notice">{notice}</p>}
    {!preview&&!review&&<>
      <div className="button-row">
        <strong>已选 {chosen.length}/3 封</strong>
        <button type="button" className="secondary-button"
          disabled={busy||!chosen.length} onClick={()=>setChosen([])}>清空选择</button>
      </div>
      <ul className="mail-list mail-review-list">
        {messages.slice(0,30).map(item=><li key={mailAIKey(item)}>
          <label>
            <input type="checkbox" disabled={busy||
              (chosen.length>=3&&!chosen.some(x=>mailAIKey(x)===mailAIKey(item)))}
              checked={chosen.some(x=>mailAIKey(x)===mailAIKey(item))}
              onChange={event=>select(item,event.target.checked)}/>
            {" "}<strong>{item.subject}</strong>
          </label>
          <div className="mail-meta">{item.from} · {item.date??"日期未提供"}</div>
        </li>)}
      </ul>
      <p className="privacy-note">这里列出最近 30 封已缓存邮件基本信息供主动选择，不会自动分析收件箱。</p>
      <label><input type="checkbox" checked={includeBodies} disabled={busy}
        onChange={e=>setIncludeBodies(e.target.checked)}/>
        本次仅对已选邮件读取纯文本正文供 AI 提取（每封最多 1100 字符，另行确认授权）
      </label>
      <p className="privacy-note">正文仅在本次授权后按需从邮箱只读获取，不能离线读取；不会保存在本机邮件数据库，附件和 HTML 不会提供给 AI。</p>
      <button type="button" className="primary-button" disabled={
        busy||!configured||chosen.length===0}
        onClick={()=>void prepare()}>{includeBodies?"先授权读取正文，再预览 AI 外发内容":"预览所选邮件基本信息的 AI 外发内容"}</button>
    </>}
    {preview&&<div role="region" aria-label="邮件 AI 付费请求确认" className="ai-preview">
      <h3>发送前逐字核对</h3>
      <p>目标：{preview.endpointLabel}（{preview.provider}） · 模型：{preview.model}。下列文字就是本次实际发送的全部提示词：</p>
      <div className="ai-question-preview" style={{whiteSpace:"pre-wrap"}}>{preview.prompt}</div>
      <p className="privacy-note">此确认一次有效，截止至
        {new Date(preview.expiresAt).toLocaleString("zh-CN")}。
        不会自动重试；如果请求状态未知，请先核对 API 用量。</p>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy}
          onClick={()=>void confirm()}>确认调用所选服务商生成候选（可能付费）</button>
        <button type="button" className="secondary-button" disabled={busy}
          onClick={()=>void cancel()}>取消，不发送所选邮件信息</button>
      </div>
    </div>}
    {review&&<div role="region" aria-label="人工核对 AI 邮件候选">
      <h3>AI 候选 · {review.items.length} 封</h3>
      <p className="privacy-note">模型：{review.model}；结果只保留在当前运行内存。
        可编辑建议标题及日期，所有内容仍需人工确认。
        本轮候选有效至 {new Date(review.expiresAt).toLocaleString("zh-CN")}。
        模型建议的截止日期只允许来自主题中明确存在的 YYYY-MM-DD；
        也可以由你手动补充正确日期。</p>
      <ul className="mail-list mail-review-list">
        {review.items.map(item=>{
          const key=mailAIKey(item),edited=edits[key];
          const done=accepted.includes(key);
          return <li key={key}>
            <strong>{item.subject}</strong>
            <div className="mail-meta">
              <span>{kindLabel[item.kind]}</span>
              <span>AI 理由：{item.reason||"未提供"}</span>
            </div>
            {item.kind!=="none"&&edited&&<>
              <label>个人任务标题
                <input type="text" maxLength={120} required
                  disabled={busy||done} value={edited.title}
                  onChange={e=>setEdits(v=>({...v,[key]:{
                    ...edited,title:e.target.value,
                  }}))}/>
              </label>
              <label>任务截止日期（可留空，AI 不能把收件日期作为截止日期）
                <input type="date" disabled={busy||done} value={edited.dueDate}
                  onChange={e=>setEdits(v=>({...v,[key]:{
                    ...edited,dueDate:e.target.value,
                  }}))}/>
              </label>
              <button type="button" className="primary-button"
                disabled={busy||done||!edited.title.trim()}
                onClick={()=>void accept(item)}>
                {done?"已记录个人任务":"核对并创建本机任务"}
              </button>
            </>}
            {item.kind==="none"&&<p className="privacy-note">
              没有可自动确认的待办，可返回原邮件手动创建任务。
            </p>}
          </li>;
        })}
      </ul>
      <button type="button" className="secondary-button" disabled={busy}
        onClick={()=>void cancel()}>结束本次分析并清除候选</button>
    </div>}
  </section>;
}
