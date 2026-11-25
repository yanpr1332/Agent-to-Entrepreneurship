import {useEffect,useState} from "react";
import type {KnowledgeDocument,KnowledgeBatchImportResult,
  KnowledgeSourceAuditEntry,KnowledgeSourceRefreshResult} from "../../shared/knowledge-model";
import {prepareKnowledgeRefresh} from "./knowledge-source-lifecycle-ui";

interface Props {documents:KnowledgeDocument[];onChanged:()=>Promise<void>;}
function detail(error:unknown):string{
  return error instanceof Error?error.message:"本机资料操作未完成";
}
const auditLabel:Record<KnowledgeSourceAuditEntry["status"],string>={
  changed:"原文已更改，尚未写入本机索引",
  unchanged:"未变化",
  missing:"原文件已移动或不存在（已导入快照保留）",
  unreadable:"当前无法安全读取（已导入快照保留）",
  stale:"检查时资料已更新，请重新检查",
};

export default function KnowledgeSourceLifecycle({documents,onChanged}:Props){
  const [open,setOpen]=useState(false);
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [audit,setAudit]=useState<KnowledgeSourceAuditEntry[]|null>(null);
  const [refreshIds,setRefreshIds]=useState<string[]>([]);
  const [batch,setBatch]=useState<KnowledgeBatchImportResult|null>(null);
  const [refreshed,setRefreshed]=useState<KnowledgeSourceRefreshResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    const present=new Set(documents.map(d=>d.id));
    setSelectedIds(previous=>previous.filter(id=>present.has(id)));
    // Never reuse a previous disk fingerprint after a collection reload.
    setAudit(null);setRefreshIds([]);
  },[documents]);

  function select(id:string,checked:boolean):void{
    setAudit(null);setRefreshIds([]);
    if(!checked){setSelectedIds(ids=>ids.filter(x=>x!==id));return;}
    if(selectedIds.length>=20){setError("一次最多检查 20 份已导入资料");return;}
    setSelectedIds(ids=>ids.includes(id)?ids:[...ids,id]);
    setError("");
  }

  async function importBatch():Promise<void>{
    setBusy(true);setError("");setNotice("");setBatch(null);setRefreshed(null);
    try{
      const result=await window.desktop.knowledge.importBatch();
      if(!result)return; // Native picker canceled; leave existing snapshots.
      setBatch(result);
      const changed=result.items.filter(i=>i.status==="added"||i.status==="updated");
      if(changed.length){await onChanged();}
      setNotice("本次选择 "+result.selected+" 份 · 新增 "+result.items.filter(i=>i.status==="added").length+
        " · 更新 "+result.items.filter(i=>i.status==="updated").length+
        " · 未变化 "+result.items.filter(i=>i.status==="unchanged").length+
        " · 失败 "+result.items.filter(i=>i.status==="failed").length+
        "。每份单独处理，失败项不删除原有索引。");
    }catch(reason){setError(detail(reason));}
    finally{setBusy(false);}
  }

  async function checkSources():Promise<void>{
    if(!selectedIds.length){setError("先选择要检查的已导入资料");return;}
    setBusy(true);setError("");setNotice("");setAudit(null);setRefreshed(null);
    try{
      const rows=await window.desktop.knowledge.auditSources(selectedIds);
      setAudit(rows);
      setRefreshIds(rows.filter(x=>x.status==="changed").map(x=>x.documentId));
      setNotice("只读检查完成。没有自动替换任何原文快照或更新复习卡。");
    }catch(reason){setError(detail(reason));}
    finally{setBusy(false);}
  }

  async function confirmRefresh():Promise<void>{
    if(!audit)return;
    const selections=prepareKnowledgeRefresh(audit,refreshIds);
    if(!selections.length){setError("请勾选至少一份已变化的源文件");return;}
    if(!window.confirm("将重新读取并更新所选 "+selections.length+
      " 份原始文件在本机知识库中的快照和索引；对应旧复习卡及知识图谱证据会标记为待核对。"+
      "若文件在检查后又变化、本地版本不符或无法读取，则保留旧快照并报告失败。"+
      "不会修改原始文件或上传内容。确认刷新？"))return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await window.desktop.knowledge.refreshSources(true,selections);
      setRefreshed(result);
      // A disk snapshot is strictly single-use, even after partial failure.
      setAudit(null);setRefreshIds([]);
      if(result.items.some(x=>x.status==="updated"))await onChanged();
      setNotice("刷新结束：更新 "+result.items.filter(x=>x.status==="updated").length+
        " · 未变化 "+result.items.filter(x=>x.status==="unchanged").length+
        " · 失败 "+result.items.filter(x=>x.status==="failed").length+
        "。如需继续处理失败项，请重新检查文件。");
    }catch(reason){setError(detail(reason));}
    finally{setBusy(false);}
  }

  return <section className="panel kb-source-lifecycle">
    <div className="eyebrow">LOCAL SOURCE LIFECYCLE</div>
    <h3>批量导入与原文更新检查</h3>
    <p className="privacy-note">一次最多从系统文件选择器导入 20 份 PDF、Markdown、HTML、
      LaTeX 或 TXT；逐份验证格式与体积，失败项不会影响其他文件。仅处理你主动选择的文件，
      不会扫描目录、后台监控或上传资料。</p>
    <div className="button-row">
      <button className="secondary-button" type="button" disabled={busy}
        onClick={()=>void importBatch()}>批量选择文件并导入（最多 20 份）</button>
      <button className="secondary-button" type="button" disabled={busy}
        onClick={()=>setOpen(!open)}>{open?"收起来源更新工具":"检查已导入原文件是否变化"}</button>
    </div>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {notice&&<p className="connector-notice" role="status">{notice}</p>}
    {batch&&<details open>
      <summary>本次文件导入报告 · {batch.selected} 份</summary>
      <ul className="kb-review-list">{batch.items.map((item,index)=><li key={index}>
        <strong>{item.title}</strong> ·
        {item.status==="added"?"新增":
          item.status==="updated"?"重新导入并更新":
          item.status==="unchanged"?"原文未变化":
          item.status==="duplicate"?"重复选择，已跳过":"导入失败"}
        {item.reason?" · "+item.reason:""}
      </li>)}</ul>
    </details>}
    {open&&<div>
      <p className="privacy-note">下方只列出**之前已通过原生文件选择器导入的来源**。
        勾选后点击“检查”，Main 才读取这些来源文件。检查过程不会修改数据库；
        之后仍需你选择要刷新的变化项并再次确认。最多一次检查 20 份资料。</p>
      <div className="button-row">
        <button type="button" className="secondary-button" disabled={busy||!documents.length}
          onClick={()=>{setSelectedIds(documents.slice(0,20).map(d=>d.id));
            setAudit(null);setError("");}}>选择前 20 份</button>
        <button type="button" className="secondary-button" disabled={busy}
          onClick={()=>{setSelectedIds([]);setAudit(null);setRefreshIds([]);}}>
          清空选择</button>
        <span>已选 {selectedIds.length}/20</span>
      </div>
      <ul className="kb-review-list">{documents.map(doc=><li key={doc.id}>
        <label><input type="checkbox" checked={selectedIds.includes(doc.id)}
          disabled={busy||(!selectedIds.includes(doc.id)&&selectedIds.length>=20)}
          onChange={event=>select(doc.id,event.target.checked)}/>
          {" "+doc.title} · v{doc.revision} · {doc.format.toUpperCase()}</label>
      </li>)}</ul>
      <button type="button" className="secondary-button" disabled={busy||!selectedIds.length}
        onClick={()=>void checkSources()}>只读检查所选 {selectedIds.length} 份来源</button>
      {audit&&<div>
        <h4>检查结果（刷新前）</h4>
        <ul className="kb-review-list">{audit.map(item=><li key={item.documentId}>
          <span>{item.title} · v{item.revision} · {auditLabel[item.status]}</span>
          {item.status==="changed"&&<label>
            <input type="checkbox" disabled={busy}
              checked={refreshIds.includes(item.documentId)}
              onChange={e=>setRefreshIds(prev=>e.target.checked?
                [...prev,item.documentId]:prev.filter(x=>x!==item.documentId))}/>
            选择刷新这份来源</label>}
        </li>)}</ul>
        {refreshIds.length>0&&<button type="button" className="primary-button"
          disabled={busy} onClick={()=>void confirmRefresh()}>
          确认刷新已勾选的 {refreshIds.length} 份变动资料</button>}
      </div>}
      {refreshed&&<details open>
        <summary>最近一次刷新报告</summary>
        <ul className="kb-review-list">{refreshed.items.map(item=><li key={item.documentId}>
          {item.title} · {item.status==="updated"?"成功更新":
          item.status==="unchanged"?"原文未变化":"更新失败"}
          {item.reason?" · "+item.reason:""}
        </li>)}</ul>
      </details>}
    </div>}
  </section>;
}
