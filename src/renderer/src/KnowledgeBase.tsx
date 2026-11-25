import { useEffect, useState, type FormEvent } from "react";
import KnowledgeGraph from "./KnowledgeGraph";
import SafeKnowledgePreview from "./SafeKnowledgePreview";
import KnowledgeAIHelper from "./KnowledgeAIHelper";
import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeReviewCard, ReviewProgress, ReviewRating, KnowledgePassage, KnowledgeEmbeddingStatus,
} from "../../shared/knowledge-model";

function detail(error:unknown):string{
  return error instanceof Error?error.message:"本地知识库操作未完成";
}
const emptyProgress:ReviewProgress={due:0,total:0,reviewedToday:0};
const day=()=>new Date().toISOString().slice(0,10);

export default function KnowledgeBase(){
  const [documents,setDocuments]=useState<KnowledgeDocument[]>([]);
  const [selected,setSelected]=useState<KnowledgeSnapshot|null>(null);
  const [passage,setPassage]=useState<KnowledgePassage|null>(null);
  const [query,setQuery]=useState("");
  const [results,setResults]=useState<KnowledgeSearchHit[]>([]);
  const [embeddingStatus,setEmbeddingStatus]=useState<KnowledgeEmbeddingStatus|null>(null);
  const [cards,setCards]=useState<KnowledgeReviewCard[]>([]);
  const [progress,setProgress]=useState<ReviewProgress>(emptyProgress);
  const [sourceOrdinal,setSourceOrdinal]=useState<number|null>(null);
  const [question,setQuestion]=useState("");
  const [answer,setAnswer]=useState("");
  const [revealed,setRevealed]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [activeTab,setActiveTab]=useState<"library"|"review"|"graph">("library");
  const [readingMode,setReadingMode]=useState<"preview"|"source">("preview");

  async function reload():Promise<void>{
    const [docs,items,summary,embeddings]=await Promise.all([
      window.desktop.knowledge.documents(),window.desktop.knowledge.cards(),
      window.desktop.knowledge.progress(),window.desktop.knowledge.embeddingStatus(),
    ]);
    setDocuments(docs);setCards(items);setProgress(summary);setEmbeddingStatus(embeddings);
  }

  useEffect(()=>{
    let active=true;
    void Promise.all([
      window.desktop.knowledge.documents(),window.desktop.knowledge.cards(),
      window.desktop.knowledge.progress(),window.desktop.knowledge.embeddingStatus(),
    ]).then(([docs,items,summary,embeddings])=>{
      if(!active)return;
      setDocuments(docs);setCards(items);setProgress(summary);setEmbeddingStatus(embeddings);
    }).catch(reason=>{if(active)setError(detail(reason));});
    return ()=>{active=false;};
  },[]);

  useEffect(()=>{
    if(!embeddingStatus?.running)return;
    let active=true;
    const timer=window.setInterval(()=>{
      void window.desktop.knowledge.embeddingStatus().then(value=>{
        if(active)setEmbeddingStatus(value);
      }).catch(()=>{});
    },1200);
    return ()=>{active=false;window.clearInterval(timer);};
  },[embeddingStatus?.running]);

  async function perform(fn:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await fn();}catch(reason){setError(detail(reason));}
    finally{setBusy(false);}
  }

  function chooseSource(doc:KnowledgeSnapshot,part:KnowledgePassage):void{
    setSelected(doc);setPassage(part);setSourceOrdinal(part.ordinal);
    setReadingMode("preview");
    setQuestion("");setAnswer("");
  }

  async function openDocument(id:string,ordinal:number|null=null):Promise<void>{
    await perform(async()=>{
      const [doc,part]=await Promise.all([
        window.desktop.knowledge.get(id),
        window.desktop.knowledge.passage(id,ordinal??0),
      ]);
      chooseSource(doc,part);
    });
  }

  async function importFile():Promise<void>{
    await perform(async()=>{
      const imported=await window.desktop.knowledge.importFile();
      if(!imported)return; // Native file picker cancelled.
      const [doc,part]=await Promise.all([
        window.desktop.knowledge.get(imported.document.id),
        window.desktop.knowledge.passage(imported.document.id,0),
      ]);
      chooseSource(doc,part);
      await reload();
      setResults([]);
      setNotice(imported.changed
        ?"资料已建立本机全文索引；原文件未被修改或上传，阅读预览不会执行文档代码。"
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
    if(!window.confirm(`删除本地知识库中的「${selected.title}」、复习卡及对应知识图谱节点/关系？原始磁盘文件不会删除。`))return;
    await perform(async()=>{
      await window.desktop.knowledge.delete(selected.id);
      setSelected(null);setPassage(null);setSourceOrdinal(null);setResults([]);
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

  async function importOfflineModel():Promise<void>{
    if(!window.confirm(
      "仅导入你自行获得、已确认来源及许可的本机 UTF-8 .vec 词向量文件（最大 32 MiB）。"+
      "Study Anchor 不会联网下载模型，也不会上传个人资料；模型文件会复制到本机数据目录。"+
      "这是静态词向量模型，不是 E5/BGE Transformer，检索质量取决于词表覆盖率。继续？"))return;
    await perform(async()=>{
      const status=await window.desktop.knowledge.importOfflineModel(true);
      if(!status)return;
      setEmbeddingStatus(status);
      setNotice("离线词向量模型已校验并导入。点击「构建本机语义索引」才会处理已导入的资料。");
    });
  }
  async function startOfflineIndex():Promise<void>{
    await perform(async()=>{
      const status=await window.desktop.knowledge.startOfflineIndex();
      setEmbeddingStatus(status);
      setNotice("已开始在本机逐批生成词向量；可取消，已写入的完整批次会保留。");
    });
  }
  async function cancelOfflineIndex():Promise<void>{
    await perform(async()=>{
      setEmbeddingStatus(await window.desktop.knowledge.cancelOfflineIndex());
      setNotice("已请求取消后续索引；再次开始可从尚未索引的资料继续。");
    });
  }
  async function removeOfflineModel():Promise<void>{
    if(!window.confirm(
      "删除本机已安装的词向量模型副本及全部派生向量？原文、复习卡和知识图谱不会删除。"+
      "模型来源文件及历史磁盘备份不会被自动擦除。"))return;
    await perform(async()=>{
      setEmbeddingStatus(await window.desktop.knowledge.removeOfflineModel(
        "REMOVE_LOCAL_MODEL_AND_VECTORS"));
      setResults([]);
      setNotice("本机模型副本及当前向量索引已清除，原始知识库资料仍完整保留。");
    });
  }

  const dueCards=cards.filter(card=>card.nextDue<=day());
  const currentSource=passage?.body??null;

  return <section className="kb-page">
    <div className="page-heading">
      <div><div className="eyebrow">OFFLINE KNOWLEDGE</div><h1>个人知识库</h1>
        <p>原文可追溯的本地索引 · 安全阅读 · 离线容错检索 · 自编复习卡</p></div>
      <span className="count-chip">{documents.length} 份本机资料</span>
    </div>
    <div className="connector-warning" role="note">
      <strong>本地优先：</strong>支持明确选择的 UTF-8 Markdown、HTML、LaTeX、TXT（2 MiB）
      与有可选择文字的 PDF（12 MiB、120 页）。预览仅支持安全标签和常用 MathML 公式，
      不执行 HTML 脚本、远程资源或 TeX 命令。完整 TeX 编译、复杂宏包、图片 PDF OCR、
      Office 与录音转写尚未实现。离线阅读和搜索不会上传资料；
      只有你在下方逐段核对并明确确认时，才会进行可计费的单次 AI 解释。
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <div className="kb-toolbar">
      <div className="filter-tabs">
        <button className={activeTab==="library"?"chip selected":"chip"}
          onClick={()=>setActiveTab("library")}>资料与搜索</button>
        <button className={activeTab==="graph"?"chip selected":"chip"}
          onClick={()=>setActiveTab("graph")}>知识图谱</button>
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
            placeholder="例如 DNA polymerase / 实验报告；支持少量拼写偏差" />
          <button className="secondary-button" disabled={busy} type="submit">本地搜索</button>
        </div>
      </form>
      <div className="panel">
        <div className="eyebrow">OPT-IN OFFLINE EMBEDDINGS</div>
        <h3>本机词向量语义索引（可选）</h3>
        <p className="privacy-note" role="status">
          {embeddingStatus?.installed
            ? "已安装静态词向量模型 · 已索引 "+embeddingStatus.indexed+
              " / 不在词表内 "+(embeddingStatus.skipped??0)+
              " / 待处理 "+(embeddingStatus.pending??0)+
              " / 总片段 "+embeddingStatus.total+"。搜索保留精确、容错及有效语义证据。"
            : "未启用语义模型：当前只使用精确及容错搜索，不会自动下载任何模型。"}
          {embeddingStatus?.running?" · 正在构建索引，可随时取消。":""}
          {embeddingStatus?.error?" · "+embeddingStatus.error:""}
        </p>
        <div className="button-row">
          <button type="button" className="secondary-button" disabled={busy||embeddingStatus?.running}
            onClick={()=>void importOfflineModel()}>导入本机 .vec 词向量</button>
          {embeddingStatus?.installed&&<>
            <button type="button" className="secondary-button"
              disabled={busy||embeddingStatus.running}
              onClick={()=>void startOfflineIndex()}>构建/继续本地索引</button>
            <button type="button" className="secondary-button"
              disabled={busy||!embeddingStatus.running}
              onClick={()=>void cancelOfflineIndex()}>取消索引</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={()=>void removeOfflineModel()}>卸载本机模型与向量</button>
          </>}
        </div>
        <p className="privacy-note">
          仅支持用户自备的有词表标题行的 UTF-8 静态词向量；不是 E5/BGE Transformer。
          中文词表覆盖率不足或未命中时自动保留原有搜索结果。权重来源与使用许可需你自行核对，
          文件不会被上传，也不会读取原始资料路径以外的文件。
        </p>
      </div>
      {results.length>0&&<section className="panel kb-results">
        <div className="eyebrow">TRACEABLE EXCERPTS</div><h2>搜索结果 · {results.length} 条</h2>
        <ul className="kb-result-list">{results.map(hit=><li
          key={`${hit.documentId}:${hit.ordinal}`}>
          <button className="kb-source-link" disabled={busy}
            onClick={()=>void openHit(hit)}>{hit.documentTitle} · {hit.matchType==="fuzzy"?"容错匹配 · ":hit.matchType==="semantic"?"本地语义 · ":""}{hit.pageNumber?`PDF 第 ${hit.pageNumber} 页 · `:""}原文片段 #{hit.ordinal+1} · v{hit.documentRevision}</button>
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
            <small>{doc.format==="pdf"?"PDF":doc.format==="markdown"?"Markdown":doc.format==="html"?"HTML":doc.format==="latex"?"LaTeX":"TXT"}
              {doc.pageCount?` · ${doc.pageCount} 页`:""} · {Math.ceil(doc.byteLength/1024)} KiB · 第 {doc.revision} 版 · {doc.chunkCount} 段</small>
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
            {passage?.pageNumber&&<p className="kb-page-citation">
              当前定位：PDF 第 {passage.pageNumber} 页 · 片段 #{passage.ordinal+1} · 第 {passage.revision} 版
            </p>}
            <div className="kb-reading-switch" role="group" aria-label="文档阅读模式">
              <button className={readingMode==="preview"?"chip selected":"chip"}
                type="button" onClick={()=>setReadingMode("preview")}>阅读预览</button>
              <button className={readingMode==="source"?"chip selected":"chip"}
                type="button" onClick={()=>setReadingMode("source")}>原始源码</button>
            </div>
            {readingMode==="source"?
              <pre className="kb-source-preview">{selected.text}</pre>:
              <SafeKnowledgePreview format={selected.format} text={selected.text}/>}
            {passage&&<details className="kb-passage-evidence">
              <summary>已定位原文证据 · 片段 #{passage.ordinal+1}
                {passage.pageNumber?" · PDF 第 "+passage.pageNumber+" 页":""} · v{passage.revision}</summary>
              <pre>{currentSource}</pre>
            </details>}
            <p className="privacy-note">阅读预览仅解析受限的 Markdown、HTML、LaTeX 结构；
              忽略 HTML 属性和远程资源，未实现的 TeX 命令可能以文本显示。源码与复习卡引用均来自本机快照。</p>
            {passage&&<KnowledgeAIHelper
              key={selected.id+":"+selected.revision+":"+passage.ordinal} passage={passage}/>}
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

    {activeTab==="graph"&&<KnowledgeGraph onOpenSource={async(id,ordinal)=>{
      setActiveTab("library");await openDocument(id,ordinal);
    }}/>} 

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
            <strong>原始证据（导入时保存）
              {card.sourcePage?` · PDF 第 ${card.sourcePage} 页`:""}
            </strong><blockquote>{card.evidence}</blockquote>
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
