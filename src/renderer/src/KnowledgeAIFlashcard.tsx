import { useEffect, useState } from "react";
import type { AIPreview, AIStatus } from "../../shared/ai-model";
import type { KnowledgePassage } from "../../shared/knowledge-model";
import { buildFlashcardRequest, parseFlashcardCandidate, type FlashcardCandidate } from "../../shared/knowledge-ai-card";

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "AI 复习卡候选处理失败";
}

/** Explicit model transmission, verifiable source quote, and separate local write approval. */
export default function KnowledgeAIFlashcard({
  passage, onCreated,
}: {passage:KnowledgePassage;onCreated:()=>Promise<void>}) {
  const [status,setStatus]=useState<AIStatus|null>(null);
  const [intent,setIntent]=useState<AIPreview|null>(null);
  const [candidate,setCandidate]=useState<FlashcardCandidate|null>(null);
  const [excerpt,setExcerpt]=useState("");
  const [reviewed,setReviewed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    let active=true;
    void window.desktop.ai.status().then(value=>{if(active)setStatus(value);})
      .catch(reason=>{if(active)setError(errorMessage(reason));});
    return ()=>{active=false;};
  },[]);

  async function prepare(): Promise<void> {
    if (busy || intent) return;
    setBusy(true);setError("");setNotice("");setCandidate(null);setReviewed(false);
    try {
      const request=buildFlashcardRequest(passage);
      const prepared=await window.desktop.ai.prepare(request.prompt);
      setExcerpt(request.excerpt);setIntent(prepared);
    } catch(reason) {setError(errorMessage(reason));}
    finally {setBusy(false);}
  }
  async function cancel(): Promise<void> {
    if(busy || !intent)return;
    setBusy(true);setError("");
    try {
      await window.desktop.ai.cancel();
      setIntent(null);setNotice("已取消，没有上传新的段落。");
    } catch(reason){setError(errorMessage(reason));}
    finally {setBusy(false);}
  }
  async function confirm(): Promise<void> {
    if(busy || !intent)return;
    const approval=intent.approvalId;
    setBusy(true);setError("");setNotice("");
    try {
      const answer=await window.desktop.ai.confirm(approval);
      const proposed=parseFlashcardCandidate(answer.text,excerpt);
      setCandidate(proposed);
      setNotice("这是未经核实的 AI 候选。请对照本机原文，修改问题和答案并手动确认后才能写入复习卡。");
    } catch(reason){setError(errorMessage(reason));}
    finally{
      setIntent(null);setBusy(false);
      try{setStatus(await window.desktop.ai.status());}catch{ /* Read-only status refresh. */ }
    }
  }
  async function save(): Promise<void> {
    if(busy || !candidate || !reviewed)return;
    setBusy(true);setError("");setNotice("");
    try {
      // Guard against changing source revision while an AI request was in flight.
      const latest=await window.desktop.knowledge.passage(passage.documentId,passage.ordinal);
      if(!latest || latest.revision!==passage.revision || latest.body!==passage.body)
        throw Error("原文已发生变化，请重新选取片段并生成复习卡。");
      const parsed=parseFlashcardCandidate(
        JSON.stringify(candidate),excerpt
      );
      await window.desktop.knowledge.createCard({
        documentId:passage.documentId,
        sourceOrdinal:passage.ordinal,
        question:parsed.question,
        answer:parsed.answer,
      });
      await onCreated();
      setCandidate(null);setReviewed(false);
      setNotice("已人工审核并保存本地复习卡，引用当前原文版本。");
    }catch(reason){setError(errorMessage(reason));}
    finally{setBusy(false);}
  }
  return <section className="kb-ai-helper" aria-label="AI 辅助复习卡候选">
    <div className="eyebrow">SOURCE-VERIFIED · OPTIONAL AI CARD</div>
    <h3>从这一段原文生成可编辑复习卡候选</h3>
    <p className="privacy-note">三次独立动作：预览将外发的当前片段 → 明确确认可能付费的模型调用 →
      对照本地原文修改并人工核对候选后保存。默认不上传、不生成、不写库。</p>
    <p className="help-text">{status?.connected
      ? "已连接 "+status.model+" · 今日剩余 "+status.remainingToday+" 次"
      : "未连接 AI 服务时可以继续手动创建复习卡。"}</p>
    {!intent && !candidate && <button type="button" className="secondary-button" disabled={busy||!status?.connected||status.remainingToday===0}
      onClick={()=>void prepare()}>{busy?"准备中…":"第一步：预览 AI 闪卡生成请求"}</button>}
    {intent && <div className="ai-preview" role="region" aria-label="复习卡模型外传内容预览">
      <strong>第二步：确认发送单个原文片段</strong>
      <p>完整外发文本和模型：{intent.model}</p>
      <pre className="ai-question-preview">{intent.prompt}</pre>
      <p className="privacy-note">原文：{passage.documentTitle} · 第 {passage.revision} 版 · 片段 #{passage.ordinal+1}
        {passage.pageNumber?" · PDF "+passage.pageNumber+" 页":""}。请求可能产生费用，不自动重试。</p>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy} onClick={()=>void confirm()}>确认外传并生成候选</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={()=>void cancel()}>取消</button>
      </div>
    </div>}
    {candidate && <div className="ai-preview" role="region" aria-label="人工核对 AI 闪卡">
      <strong>第三步：人工编辑、逐字核对原文再保存</strong>
      <label>候选问题<input value={candidate.question} maxLength={500}
        onChange={event=>{setCandidate({...candidate,question:event.target.value});setReviewed(false);}}/></label>
      <label>候选答案<textarea value={candidate.answer} rows={4} maxLength={2000}
        onChange={event=>{setCandidate({...candidate,answer:event.target.value});setReviewed(false);}}/></label>
      <p>模型声称的原文连续引用（只能用于人工核对，不等于答案准确）：</p>
      <pre className="kb-ai-source-evidence">{candidate.evidenceQuote}</pre>
      <details><summary>查看本机完整选定片段</summary><pre className="kb-ai-source-evidence">{passage.body}</pre></details>
      <label><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>
        我已阅读当前原文、核对问题和答案；同意保存此候选为本地复习卡。</label>
      <div className="button-row">
        <button type="button" className="primary-button" disabled={busy||!reviewed||!candidate.question.trim()||!candidate.answer.trim()}
          onClick={()=>void save()}>确认保存到本机知识库</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={()=>{setCandidate(null);setReviewed(false);}}>丢弃候选</button>
      </div>
    </div>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    {notice&&<p className="privacy-note" role="status">{notice}</p>}
  </section>;
}
