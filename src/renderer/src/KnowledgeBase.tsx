import { useEffect, useState, type FormEvent } from "react";
import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeReviewCard, ReviewProgress, ReviewRating,
} from "../../shared/knowledge-model";

function detail(error:unknown):string{
  return error instanceof Error?error.message:"本地知识库操作未完成";
}
const emptyProgress:ReviewProgress={due:0,total:0,reviewedToday:0};
const day=()=>new Date().toISOString().slice(0,10);

export default function KnowledgeBase(){
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]);
  const [selected,setSelected]=useState<KnowledgeSnapshot|null>(null);
  const [query,setQuery]=useState("");
  const [results,setResults]=useState<KnowledgeSearchHit[]>([]);
  const [cards,setCards]=useState<KnowledgeReviewCard[]>([]);
  const [progress,setProgress]=useState<ReviewProgress>(emptyProgress);
  const [sourceOrdinal,setSourceOrdinal]=useState<number|null>(null);
  const [question,setQuestion]=useState("");
  const [answer,setAnswer]=useState("");
  const [revealed,setRevealed]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [activeTab,setActiveTab]=useState<"library"|"review">("library");

  async function reload():Promise<void>{
    const [docs,items,summary]=await Promise.all([
      window.desktop.knowledge.documents(),window.desktop.knowledge.cards(),
      window.desktop.knowledge.progress(),
    ]);
    setDocuments(docs);setCards(items);setProgress(summary);
  }

  useEffect(()=>{
    let active=true;
    void Promise.all([
      window.desktop.knowledge.documents(),window.desktop.knowledge.cards(),
      window.desktop.knowledge.progress(),
    ]).then(([docs,items,summary])=>{
      if(!active)return;
      setDocuments(docs);setCards(items);setProgress(summary);
    }).catch(reason=>{if(active)setError(detail(reason));});
    return ()=>{active=false;};
  },[]);

  async function perform(fn:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await fn();}catch(reason){setError(detail(reason));}
    finally{setBusy(false);}
  }

  function chooseSource(doc:KnowledgeSnapshot,ordinal:number):void{
    setSelected(doc);setSourceOrdinal(ordinal);
    setQuestion("");setAnswer("");
  }

  async function openDocument(id:string,ordinal:number|null=null):Promise<void>{
    await perform(async()=>{
      const doc=await window.desktop.knowledge.get(id);
      chooseSource(doc,ordinal??0);
    });
  }

  async function importFile():Promise<void>{
    await perform(async()=>{
      const imported=await window.desktop.knowledge.importFile();
      if(!imported)return; // Native file picker cancelled.
      const doc=await window.desktop.knowledge.get(imported.document.id);
      chooseSource(doc,0);
      await reload();
      setResults([]);
      setNotice(imported.changed
        ?"资料已建立本机全文索引；原始文件未被修改或上传。"
        :"文件内容未变化，已有索引保持不变。");
    });
  }

  async function find(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await perform(async()=>{
      setResults(await window.desktop.knowledge.search(query));
    });
  }

  async function openHit(hit:KnowledgeSearchHit):Promise<void>{
    await openDocument(hit.documentId,hit.ordinal);
    setActiveTab("library");
  }

  async function addCard(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(!selected || sourceOrdinal===null)return;
    await perform(async()=>{
      await window.desktop.knowledge.createCard({
        documentId:selected.id,sourceOrdinal,question,answer,
      });
      setQuestion("");setAnswer("");
      await reload();
      setNotice("复习卡已保存，包含该段原文证据。答案由你编写，不由 AI 猜测。");
    });
  }

  async function deleteDocument():Promise<void>{
    if(!selected)return;
    if(!window.confirm(`删除本地知识库中的「${selected.title}」及对应复习卡？原始磁盘文件不会删除。`))return;
    await perform(async()=>{
      await window.desktop.knowledge.delete(selected.id);
      setSelected(null);setSourceOrdinal(null);setResults([]);
      await reload();setNotice("索引和相关复习卡已删除；原始文件仍在原路径。");
    });
  }

  async function grade(card:KnowledgeReviewCard,rating:ReviewRating):Promise<void>{
    await perform(async()=>{
      await window.desktop.knowledge.reviewCard(card.id,rating);
      setRevealed(null);await reload();
      setNotice("已按你的自评更新下次复习日期；这是离线规则调度，不是 AI/FSRS。");
    });
  }

  async function removeCard(card:KnowledgeReviewCard):Promise<void>{
    if(!window.confirm(`删除复习卡「${card.question}」？`))return;
    await perform(async()=>{
      await window.desktop.knowledge.removeCard(card.id);
      setRevealed(null);await reload();
    });
  }

  async function backup():Promise<void>{
    if(!window.confirm("创建一次本机 SQLite 备份？备份包含个人任务、邮件头缓存与知识库，默认未单独加密。请勿把备份上传到公开位置。"))return;
    await perform(async()=>{
      const result=await window.desktop.backup.create();
      setNotice(`已在本机创建 ${result.databases.length} 份 SQLite 数据库备份并检查完整性。目录：${result.folder}。备份未单独加密，也不包含原始磁盘资料或加密登录凭据。`);
    });
  }

  const dueCards=cards.filter(card=>card.nextDue<=day());
  const currentSource=selected && sourceOrdinal!==null ?
    Array.from(selected.text).slice(sourceOrdinal*1000,sourceOrdinal*1000+1100).join("") : null;

  return <section className="kb-page">
    <div className="page-heading">
      <div><div className="eyebrow">OFFLINE KNOWLEDGE</div><h1>个人知识库</h1>
        <p>原文可追溯的本地索引 · 关键词检索 · 自编复习卡</p></div>
      <span className="count-chip">{documents.length} 份本机资料</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>本地优先：</strong>当前只支持用户选择的 UTF-8 Markdown/TXT（单文件最多 2 MiB）。
      导入会在本机数据库保存原文快照并建立 FTS5 索引；不安装 Obsidian、不上传云端、
      不调用 AI，也不扫描未授权的文件夹。PDF/OCR/录音转写与知识图谱尚未实现。
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <div className="kb-toolbar">
      <div className="filter-tabs">
        <button className={activeTab==="library"?"chip selected":"chip"}
          onClick={()=>setActiveTab("library")}>资料与搜索</button>
        <button className={activeTab==="review"?"chip selected":"chip"}
          onClick={()=>setActiveTab("review")}>今日复习 ({progress.due})</button>
      </div>
      <div className="button-row">
        <button className="secondary-button" disabled={busy} onClick={()=>void backup()}>
          备份本地数据库
        </button>
        <button className="primary-button" disabled={busy} onClick={()=>void importFile()}>
          {busy?"处理中…":"选择并导入资料"}
        </button>
      </div>
    </div>

    {activeTab==="library"&&<>
      <form className="kb-search" onSubmit={event=>void find(event)}>
        <label htmlFor="kb-search-input">全文搜索</label>
        <div className="kb-search-row">
          <input id="kb-search-input" type="search" maxLength={120} required value={query}
            onChange={event=>setQuery(event.target.value)}
            placeholder="输入关键字，例如 DNA polymerase / 实验报告" />
          <button className="secondary-button" disabled={busy} type="submit">搜索原文</button>
        </div>
      </form>
      {results.length>0&&<section className="panel kb-results">
        <div className="eyebrow">TRACEABLE EXCERPTS</div><h2>搜索结果 · {results.length} 条</h2>
        <ul className="kb-result-list">{results.map(hit=><li
          key={`${hit.documentId}:${hit.ordinal}`}>
          <button className="kb-source-link" disabled={busy}
            onClick={()=>void openHit(hit)}>{hit.documentTitle} · 原文片段 #{hit.ordinal+1} · v{hit.documentRevision}</button>
          <p>{hit.excerpt}</p>
        </li>)}</ul>
      </section>}
      <div className="kb-layout">
        <section className="panel kb-library">
          <div className="eyebrow">LOCAL DOCUMENTS</div><h2>已导入资料</h2>
          {documents.length?
          <ul className="kb-document-list">{documents.map(doc=><li key={doc.id}>
            <button className={selected?.id===doc.id?"kb-doc-active":"kb-doc"}
              onClick={()=>void openDocument(doc.id)} disabled={busy}>{doc.title}</button>
            <small>{doc.format==="markdown"?"Markdown":"TXT"} · {Math.ceil(doc.byteLength/1024)} KiB · 第 {doc.revision} 版 · {doc.chunkCount} 段</small>
          </li>)}</ul>:
          <p className="empty-state">还没有资料。点击「选择并导入资料」开始建立私有本地知识库。</p>}
          <p className="privacy-note">再次导入同一路径会按内容哈希更新索引。导入不会编辑或删除原始文件。</p>
        </section>
        <section className="panel kb-reader">
          <div className="eyebrow">SOURCE PREVIEW</div>
          {!selected?<p className="empty-state">选择一份资料或搜索结果查看原文证据。</p>:<>
            <div className="panel-heading"><h2>{selected.title}</h2>
              <button className="secondary-button" disabled={busy}
                onClick={()=>void deleteDocument()}>从知识库移除</button></div>
            <p className="privacy-note">本机来源：{selected.sourcePath} · 文本快照版本 {selected.revision}</p>
            <div className="kb-source-preview">{currentSource??selected.text}</div>
            <p className="privacy-note">上方展示选中的文档片段；不会渲染不可信 Markdown HTML。</p>
            <form className="kb-card-form" onSubmit={event=>void addCard(event)}>
              <h3>以这段原文创建复习卡</h3>
              <label>问题<input value={question} required maxLength={500}
                onChange={event=>setQuestion(event.target.value)}
                placeholder="例如：DNA polymerase 的作用是什么？" /></label>
              <label>参考答案<textarea value={answer} required rows={3} maxLength={2000}
                onChange={event=>setAnswer(event.target.value)}
                placeholder="自行填写有原文支持的答案" /></label>
              <button className="primary-button" disabled={busy} type="submit">保存复习卡</button>
            </form>
          </>}
        </section>
      </div>
    </>}

    {activeTab==="review"&&<div className="kb-review-layout">
      <div className="kb-progress">
        <span>今日待复习 <strong>{progress.due}</strong></span>
        <span>累计复习卡 <strong>{progress.total}</strong></span>
        <span>今日已评价 <strong>{progress.reviewedToday}</strong></span>
      </div>
      {dueCards.length?dueCards.map(card=><section className="panel kb-review-card" key={card.id}>
        <div className="eyebrow">SOURCE-BASED REVIEW · {card.documentTitle}</div>
        {card.needsReview&&<p className="retention-warning">
          原文已重新导入并变化：这张卡保留了旧版证据，请核对后再学习。
        </p>}
        <h2>{card.question}</h2>
        {!revealed || revealed!==card.id?
          <button className="secondary-button" disabled={busy}
            onClick={()=>setRevealed(card.id)}>显示参考答案与原文证据</button>:
          <div className="kb-answer">
            <strong>你编写的答案</strong><p>{card.answer}</p>
            <strong>原始证据（导入时保存）</strong><blockquote>{card.evidence}</blockquote>
            <p className="privacy-note">请根据自己的掌握程度评分。一次评分对应一个 UTC 日期，不会因为重复点击重复累计。</p>
            <div className="button-row kb-rating">
              <button disabled={busy} className="secondary-button" onClick={()=>void grade(card,"again")}>重新学</button>
              <button disabled={busy} className="secondary-button" onClick={()=>void grade(card,"hard")}>困难</button>
              <button disabled={busy} className="primary-button" onClick={()=>void grade(card,"good")}>掌握</button>
              <button disabled={busy} className="primary-button" onClick={()=>void grade(card,"easy")}>容易</button>
            </div>
          </div>}
        <button className="text-button" disabled={busy} onClick={()=>void removeCard(card)}>删除这张卡</button>
      </section>):
      <section className="panel"><p className="empty-state">今天没有待复习卡片，可以导入资料并创建新卡。</p></section>}
      {cards.length>dueCards.length&&<section className="panel">
        <div className="eyebrow">LATER REVIEWS</div><h2>之后的复习</h2>
        <ul className="kb-review-list">{cards.filter(card=>card.nextDue>day()).map(card=>
          <li key={card.id}><span>{card.question}</span><small>下次：{card.nextDue}</small></li>)}</ul>
      </section>}
    </div>}
  </section>;
}
