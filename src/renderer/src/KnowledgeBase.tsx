import { useEffect, useState, type FormEvent } from "react";
import KnowledgeGraph from "./KnowledgeGraph";
import SafeKnowledgePreview from "./SafeKnowledgePreview";
import KnowledgeAIHelper from "./KnowledgeAIHelper";
import LocalEvaluationLab from "./LocalEvaluationLab";
import ReviewCardMaintenance from "./ReviewCardMaintenance";
import KnowledgeSourceLifecycle from "./KnowledgeSourceLifecycle";
import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeReviewCard, ReviewProgress, ReviewRating, KnowledgePassage, KnowledgeEmbeddingStatus, KnowledgeEvaluationReport,
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
  const [neuralKind,setNeuralKind]=useState<"e5"|"bge">("e5");
  const [evaluation,setEvaluation]=useState<KnowledgeEvaluationReport|null>(null);
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
      setEmbeddingStatus(status);setEvaluation(null);
      setNotice("离线词向量模型已校验并导入。点击「构建本机语义索引」才会处理已导入的资料。");
    });
  }
  async function importNeuralModel():Promise<void>{
    if(!window.confirm(
      "你需要自行获得并核对 E5/BGE 第三方模型的许可、来源和完整 ONNX 文件。"+
      "此设备必须已配置离线 Python 环境（numpy、onnxruntime、transformers）。"+
      "软件只复制校验过的 ONNX 权重和 tokenizer 数据，在本机 CPU 推理，绝不上传文档或在线下载权重。"+
      "只有真实推理进程通过模型与维度预检才会替换当前语义索引。继续？"
    ))return;
    await perform(async()=>{
      const result=await window.desktop.knowledge.importNeuralModel(true,neuralKind);
      if(!result)return;
      setEmbeddingStatus(result);setEvaluation(null);
      setNotice("ONNX 神经模型已通过真实 CPU 启动与维度预检。需要重新构建语义索引。");
    });
  }
  async function startOfflineIndex():Promise<void>{
    await perform(async()=>{
      const status=await window.desktop.knowledge.startOfflineIndex();
      setEmbeddingStatus(status);setEvaluation(null);
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
      setResults([]);setEvaluation(null);
      setNotice("本机模型副本及当前向量索引已清除，原始知识库资料仍完整保留。");
    });
  }

  async function exportEvidenceCatalog():Promise<void>{
    if(!window.confirm(
      "导出的本机 JSON 包含最多 500 个知识库原文片段的标题、引用 ID、PDF 页码和最多 240 字摘要。"+
      "内容可能涉及你的私人学习资料，请妥善保管、不要上传公共仓库或聊天。"+
      "文件只会保存到你在系统对话框中选择的位置，已存在文件不会被自动覆盖。继续？"))return;
    await perform(async()=>{
      const saved=await window.desktop.knowledge.exportEvidenceCatalog(true);
      if(saved)setNotice("已将 "+saved.exported+"/"+saved.total+
        " 条证据引用保存至本机："+saved.path+
        (saved.truncated?"。超出上限的片段未导出。":"。")+
        " 请人工填写标注查询与相关证据，不能直接把目录文件当成评测标签。");
    });
  }
  async function evaluateOfflineModel():Promise<void>{
    if(!window.confirm(
      "只选择你自己创建的本机 JSON 检索相关性标注文件（最多 100 条查询、128 KiB）。"+
      "本轮会在此设备上分别运行原始检索与混合检索，不会上传原文、查询或标签。"+
      "模型需要先完成至少一部分索引，耗时随标注集和设备性能变化。继续？"))return;
    await perform(async()=>{
      const result=await window.desktop.knowledge.evaluateOfflineModel(true);
      if(result){setEvaluation(result);
        setNotice("本机评测已完成；显示的分数仅适用于所选标注集和当前模型版本，不代表通用多语准确率。");
      }
    });
  }
  const pct=(value:number)=>Math.round(value*1000)/10+"%";

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
        <h3>本机语义索引（静态词向量 / E5 / BGE 神经模型）</h3>
        <p className="privacy-note" role="status">
          {embeddingStatus?.installed
            ? "已安装 "+(
              embeddingStatus.engine==="onnx-e5"?"multilingual-e5-small 神经 ONNX":
              embeddingStatus.engine==="onnx-bge"?"bge-small-zh-v1.5 神经 ONNX":
              "静态词向量")+" · 已索引 "+embeddingStatus.indexed+
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
          <label>神经模型类型
            <select value={neuralKind} disabled={busy||embeddingStatus?.running}
              onChange={e=>setNeuralKind(e.target.value as "e5"|"bge")}>
              <option value="e5">multilingual-e5-small（中英混合，384维）</option>
              <option value="bge">bge-small-zh-v1.5（中文优先，512维）</option>
            </select>
          </label>
          <button type="button" className="secondary-button"
            disabled={busy||embeddingStatus?.running}
            onClick={()=>void importNeuralModel()}>选择本地 ONNX 文件夹并启用神经推理</button>
          {embeddingStatus?.installed&&<>
            <button type="button" className="secondary-button"
              disabled={busy||embeddingStatus.running}
              onClick={()=>void startOfflineIndex()}>构建/继续本地索引</button>
            <button type="button" className="secondary-button"
              disabled={busy||!embeddingStatus.running}
              onClick={()=>void cancelOfflineIndex()}>取消索引</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={()=>void exportEvidenceCatalog()}>导出证据目录（供手动标注）</button>
            <button type="button" className="secondary-button"
              disabled={busy||embeddingStatus.running||!embeddingStatus.indexed}
              onClick={()=>void evaluateOfflineModel()}>用本地标注集评测检索</button>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={()=>void removeOfflineModel()}>卸载本机模型与向量</button>
          </>}
        </div>
        <p className="privacy-note">
          可选择本地 .vec 静态词向量，或通过自备 ONNX 文件夹启用真实 E5/BGE CPU 神经推理。
          E5 查询与文档分别添加 query:/passage: 前缀并使用 masked mean pooling；BGE 使用 CLS pooling，
          均进行 L2 归一化。神经模型需事先安装隔离 Python 和 onnxruntime、transformers、numpy。
          权重来源/许可需自行核对，原文和查询不会上传；模型文件逐个 SHA-256 校验。
          运行环境缺失或权重不兼容时失败关闭并保留原有精确/容错搜索。
          ONNX 推理速度、内存和中英相关性仍需真实设备与人工标注验收，安装成功不等于质量达标。
        </p>
        {evaluation&&<div className="kb-evaluation" role="status">
          <strong>本机标注检索评测 · {evaluation.cases} 条查询</strong>
          <p>模型版本：{evaluation.modelRevision.slice(0,12)} ·
            索引 {evaluation.indexed} · 跳过 {evaluation.skipped} · 待处理 {evaluation.pending}</p>
          <table>
            <thead><tr><th>指标</th><th>精确＋容错</th><th>混合检索</th></tr></thead>
            <tbody>
              <tr><td>Precision@5</td><td>{pct(evaluation.baseline.precisionAt5)}</td>
                <td>{pct(evaluation.hybrid.precisionAt5)}</td></tr>
              <tr><td>Recall@10</td><td>{pct(evaluation.baseline.recallAt10)}</td>
                <td>{pct(evaluation.hybrid.recallAt10)}</td></tr>
              <tr><td>MRR@10</td><td>{evaluation.baseline.mrrAt10.toFixed(3)}</td>
                <td>{evaluation.hybrid.mrrAt10.toFixed(3)}</td></tr>
              <tr><td>P50 查询延迟</td><td>{evaluation.latencyMs.lexicalP50} ms</td>
                <td>{evaluation.latencyMs.hybridP50} ms</td></tr>
              <tr><td>P95 查询延迟</td><td>{evaluation.latencyMs.lexicalP95} ms</td>
                <td>{evaluation.latencyMs.hybridP95} ms</td></tr>
            </tbody>
          </table>
          <p className="privacy-note">
            含语义候选的查询：{evaluation.semanticCases}/{evaluation.cases}。
            仅比较此标注集的证据命中，不能推断模型对所有中文/英文问题的准确率。
          </p>
        </div>}
      </div>
      <KnowledgeSourceLifecycle documents={documents} onChanged={async()=>{
        setSelected(null);setPassage(null);setSourceOrdinal(null);
        setResults([]);setEvaluation(null);await reload();
      }}/>
      <LocalEvaluationLab/>
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
              <button disabled={busy||card.needsReview} className="secondary-button" onClick={()=>void grade(card,"again")}>重新学</button>
              <button disabled={busy||card.needsReview} className="secondary-button" onClick={()=>void grade(card,"hard")}>困难</button>
              <button disabled={busy||card.needsReview} className="primary-button" onClick={()=>void grade(card,"good")}>掌握</button>
              <button disabled={busy||card.needsReview} className="primary-button" onClick={()=>void grade(card,"easy")}>容易</button>
            </div>
          </div>}
        <ReviewCardMaintenance card={card} onChanged={reload}/>
        <button className="text-button" disabled={busy} onClick={()=>void removeCard(card)}>删除这张卡</button>
      </section>):
      <section className="panel"><p className="empty-state">今天没有待复习卡片，可以导入资料并创建新卡。</p></section>}
      {cards.length>dueCards.length&&<section className="panel">
        <div className="eyebrow">LATER REVIEWS</div><h2>之后的复习</h2>
        <ul className="kb-review-list">{cards.filter(card=>card.nextDue>day()).map(card=>
          <li key={card.id}>
            <span>{card.question}</span><small>下次：{card.nextDue}</small>
            {card.needsReview&&<p className="retention-warning">来源已变化：需核对后才能复习评分。</p>}
            <ReviewCardMaintenance card={card} onChanged={reload}/>
          </li>)}</ul>
      </section>}
    </div>}
  </section>;
}
