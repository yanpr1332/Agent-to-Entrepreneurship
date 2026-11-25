import {useEffect,useState,type FormEvent} from "react";
import type {KnowledgeReviewCard,KnowledgePassage,ReviewCardEvidenceHistory}
  from "../../shared/knowledge-model";

interface Props {card:KnowledgeReviewCard;onChanged:()=>Promise<void>;}
function explain(reason:unknown):string{
  return reason instanceof Error?reason.message:"本机复习卡操作未完成";
}
/** All evidence is local and read through the existing trusted preload bridge.
 * Editing text and accepting a new citation are deliberately different actions. */
export default function ReviewCardMaintenance({card,onChanged}:Props){
  const [editing,setEditing]=useState(false);
  const [question,setQuestion]=useState(card.question);
  const [answer,setAnswer]=useState(card.answer);
  const [reviewing,setReviewing]=useState(false);
  const [source,setSource]=useState<{chunkCount:number;revision:number}|null>(null);
  const [ordinal,setOrdinal]=useState(card.sourceOrdinal);
  const [passage,setPassage]=useState<KnowledgePassage|null>(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [history,setHistory]=useState<ReviewCardEvidenceHistory[]|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    if(!editing){setQuestion(card.question);setAnswer(card.answer);}
  },[editing,card.question,card.answer]);
  useEffect(()=>{
    if(!reviewing)return;
    let active=true;
    setSource(null);setPassage(null);
    void window.desktop.knowledge.get(card.documentId).then(doc=>{
      if(!active)return;
      setSource({chunkCount:doc.chunkCount,revision:doc.revision});
      setOrdinal(Math.min(card.sourceOrdinal,Math.max(0,doc.chunkCount-1)));
    }).catch(reason=>{if(active)setError(explain(reason));});
    return ()=>{active=false;};
  },[reviewing,card.documentId,card.sourceOrdinal]);
  useEffect(()=>{
    if(!reviewing||!source||!Number.isSafeInteger(ordinal)||
      ordinal<0||ordinal>=source.chunkCount){setPassage(null);return;}
    let active=true;
    setPassage(null);
    void window.desktop.knowledge.passage(card.documentId,ordinal).then(item=>{
      if(active)setPassage(item);
    }).catch(reason=>{if(active)setError(explain(reason));});
    return ()=>{active=false;};
  },[reviewing,source?.chunkCount,source?.revision,ordinal,card.documentId]);

  async function saveEdit(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();setError("");setNotice("");setBusy(true);
    try{
      await window.desktop.knowledge.editCard({id:card.id,expectedUpdatedAt:card.updatedAt,
        question,answer});
      setEditing(false);
      setNotice("已保存文字修改，复习历史和原文引用保持不变。");
      await onChanged();
    }catch(reason){setError(explain(reason));}
    finally{setBusy(false);}
  }
  async function confirmSource():Promise<void>{
    if(!passage||!source||passage.revision!==source.revision){
      setError("原文版本已变化，请重新打开核对窗口。");return;
    }
    if(!window.confirm("你已阅读并确认这条新版原文确实支持此卡片的问答？旧证据将保存在本机版本记录中；原有复习次数和下次复习时间保持不变。"))return;
    setBusy(true);setError("");setNotice("");
    try{
      await window.desktop.knowledge.rebindCard({
        id:card.id,sourceOrdinal:passage.ordinal,
        expectedDocumentRevision:passage.revision,
        expectedUpdatedAt:card.updatedAt,
        confirmation:"CONFIRM_CURRENT_SOURCE_EVIDENCE",
      });
      setReviewing(false);setHistory(null);setHistoryOpen(false);
      setNotice("已人工确认并重新关联原文；旧引用已保存在本机历史记录。");
      await onChanged();
    }catch(reason){setError(explain(reason));}
    finally{setBusy(false);}
  }
  async function toggleHistory():Promise<void>{
    if(historyOpen){setHistoryOpen(false);return;}
    setHistoryOpen(true);setError("");
    try{setHistory(await window.desktop.knowledge.cardEvidenceHistory(card.id));}
    catch(reason){setError(explain(reason));}
  }
  return <div className="kb-card-maintenance">
    <div className="button-row">
      <button type="button" className="secondary-button" disabled={busy}
        onClick={()=>{setEditing(!editing);setError("");}}>编辑问题和答案</button>
      <button type="button" className="secondary-button" disabled={busy}
        onClick={()=>{setReviewing(!reviewing);setError("");}}>
        {card.needsReview?"核对并修复过期原文":"重新选择证据原文"}
      </button>
      <button type="button" className="text-button" disabled={busy}
        onClick={()=>void toggleHistory()}> {historyOpen?"收起":"查看"}旧证据历史</button>
    </div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {notice&&<p className="connector-notice" role="status">{notice}</p>}
    {editing&&<form className="kb-card-form" onSubmit={event=>void saveEdit(event)}>
      <label>卡片问题
        <input required maxLength={500} value={question}
          onChange={event=>setQuestion(event.target.value)}/></label>
      <label>参考答案
        <textarea required maxLength={2000} rows={3} value={answer}
          onChange={event=>setAnswer(event.target.value)}/></label>
      <p className="privacy-note">仅编辑问答文字，不更改来源、评分记录或复习日期。</p>
      <button type="submit" className="primary-button" disabled={busy}>
        保存卡片文字</button>
    </form>}
    {reviewing&&<div className="kb-passage-evidence">
      <h3>手动核对原文证据</h3>
      <p className="privacy-note">此前保存的原文快照（不能自动视为最新）：</p>
      <blockquote>{card.evidence}</blockquote>
      <p className="privacy-note">当前文档版本 {source?.revision??"读取中"}；
        原文共 {source?.chunkCount??"…"} 个片段。请选择要引用的新片段后认真阅读。</p>
      <label>原文片段序号（从 1 开始）
        <input type="number" min={1} max={source?.chunkCount??1} step={1}
          value={ordinal+1} disabled={busy||!source}
          onChange={event=>setOrdinal(Number(event.target.value)-1)} />
      </label>
      {passage?<div>
        <p className="privacy-note">新版本 v{passage.revision} · 片段 #{passage.ordinal+1}
          {passage.pageNumber?" · PDF 第 "+passage.pageNumber+" 页":""}</p>
        <pre className="kb-source-preview">{passage.body}</pre>
      </div>:<p className="privacy-note">请先选择存在的当前原文片段。</p>}
      {card.needsReview&&<p className="retention-warning">
        未核对前无法给这张卡评分。请同时核对自己编写的问答，如需修改请先保存文字再确认来源。</p>}
      <button type="button" className="primary-button"
        disabled={busy||!passage||!source||passage.revision!==source.revision}
        onClick={()=>void confirmSource()}>我已核对，确认新版证据</button>
    </div>}
    {historyOpen&&<div className="kb-passage-evidence">
      <strong>旧版原文快照（最多显示最近 30 次人工重新关联）</strong>
      {history===null?<p>正在加载本地历史…</p>:
        history.length===0?<p>暂无历史重关联记录。</p>:
        <ul className="kb-review-list">{history.map((item,index)=><li
          key={index+"-"+item.archivedAt}>
          <small>{item.archivedAt} · 原片段 #{item.sourceOrdinal+1}
            {item.sourcePage?" · PDF 第 "+item.sourcePage+" 页":""}</small>
          <blockquote>{item.evidence}</blockquote>
        </li>)}</ul>}
    </div>}
  </div>;
}
