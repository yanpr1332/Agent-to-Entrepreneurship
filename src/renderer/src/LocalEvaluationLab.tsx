import {useEffect,useState} from "react";
import type {KnowledgeEvidenceCatalogPage,KnowledgeLocalLabels}
  from "../../shared/knowledge-model";
import {appendManualLabelCase} from "./local-evaluation-labels";

const PAGE_SIZE=50;
type LocalCase=KnowledgeLocalLabels["cases"][number];

/** Local-only human relevance review. Browse the *corpus*, not just search
 * results, so users can label passages the model failed to retrieve. */
export default function LocalEvaluationLab(){
  const [open,setOpen]=useState(false);
  const [offset,setOffset]=useState(0);
  const [catalog,setCatalog]=useState<KnowledgeEvidenceCatalogPage|null>(null);
  const [filter,setFilter]=useState("");
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<string[]>([]);
  const [cases,setCases]=useState<LocalCase[]>([]);
  const [serial,setSerial]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  useEffect(()=>{
    if(!open)return;
    let alive=true;
    setBusy(true);
    void window.desktop.knowledge.evidencePage(offset).then(result=>{
      if(alive){setCatalog(result);setError("");}
    }).catch(reason=>{
      if(alive)setError(reason instanceof Error?reason.message:"读取本地证据失败");
    }).finally(()=>{if(alive)setBusy(false);});
    return ()=>{alive=false;};
  },[open,offset]);

  function toggleEvidence(key:string):void{
    setSelected(previous=>{
      if(previous.includes(key))return previous.filter(item=>item!==key);
      if(previous.length>=20){setError("每条查询最多选 20 条相关证据");return previous;}
      return [...previous,key];
    });
  }
  function addCase():void{
    try{
      const next=serial+1;
      const id="case-"+String(next).padStart(3,"0");
      setCases(previous=>appendManualLabelCase(previous,query,selected,id));
      setSerial(next);setQuery("");setSelected([]);setError("");
      setNotice("已加入人工标注查询。你可以继续浏览其他页，添加更多不同查询。");
    }catch(reason){setError(reason instanceof Error?reason.message:"添加标注失败");}
  }
  async function save():Promise<void>{
    if(!cases.length){setError("请先创建至少一条包含相关证据的标注");return;}
    if(!window.confirm("标注包含你输入的私人问题及原文引用 ID。将仅保存到本机系统对话框选定的 JSON 文件；不会自动上传、覆盖现有文件或标记模型质量已通过。继续？"))return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await window.desktop.knowledge.saveEvaluationLabels(true,{
        schema:1,cases,
      });
      if(result)setNotice("成功将 "+result.cases+" 条人工标注保存至本机："+result.path+
        "。随后点击上方“用本地标注集评测检索”并选择此文件。");
    }catch(reason){setError(reason instanceof Error?reason.message:"保存标注未完成");}
    finally{setBusy(false);}
  }
  const matches=catalog?.items.filter(item=>
    (item.title+" "+item.excerpt).toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()))??[];

  return <section className="panel kb-evaluation" aria-label="人工检索标注工具">
    <div className="eyebrow">HUMAN RELEVANCE LABELS</div>
    <h3>人工证据标注工具（仅本机）</h3>
    <p className="privacy-note">无需手写 JSON：输入一个你自己提出的检索问题，浏览全部原文证据，
      勾选真正相关的片段，逐条加入标注集，最后通过系统对话框保存。标注是你人工判断，
      不是搜索结果的自动真值；浏览不限于当前搜索命中的片段。</p>
    <button type="button" className="secondary-button" onClick={()=>setOpen(!open)}>
      {open?"收起人工标注工具":"开始创建人工标注集"}
    </button>
    {open&&<div>
      <p className="privacy-note">证据可能含有私人学习内容；数据只在本机 UI 中浏览和保存。
        本机文件请妥善保管，勿上传到公开仓库或第三方服务。</p>
      {error&&<p className="error-banner" role="alert">{error}</p>}
      {notice&&<p className="connector-notice" role="status">{notice}</p>}
      <label htmlFor="label-question">人工问题（最多 120 字）</label>
      <input id="label-question" value={query} maxLength={120}
        onChange={event=>setQuery(event.target.value)}
        placeholder="例如：线粒体是如何产生能量的？" />
      <p className="privacy-note">当前勾选 {selected.length}/20 条相关原文；
        可以跨页勾选，不会因翻页自动丢失。要标注不相关的资料，不必勾选。</p>
      <label htmlFor="label-filter">本页过滤（标题或摘要，不影响其他页）</label>
      <input id="label-filter" value={filter} maxLength={100}
        onChange={event=>setFilter(event.target.value)} placeholder="在当前 50 条证据中查找" />
      <div className="button-row">
        <button type="button" className="secondary-button"
          disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-PAGE_SIZE))}>
          上一页</button>
        <button type="button" className="secondary-button"
          disabled={busy||!catalog||offset+PAGE_SIZE>=catalog.total}
          onClick={()=>setOffset(offset+PAGE_SIZE)}>下一页</button>
        <span>原文 {catalog?.total??0} 条 · 当前 {catalog&&catalog.total?offset+1:0}–
          {Math.min(catalog?.total??0,offset+PAGE_SIZE)} 条</span>
      </div>
      {busy&&!catalog?<p>正在读取本机原文目录…</p>:null}
      <ul className="kb-result-list">
        {matches.map(item=><li key={item.evidenceKey}>
          <label>
            <input type="checkbox" checked={selected.includes(item.evidenceKey)}
              disabled={busy||(!selected.includes(item.evidenceKey)&&selected.length>=20)}
              onChange={()=>toggleEvidence(item.evidenceKey)} />
            {" "+item.title+" · "+
              (item.pageNumber?"PDF 第 "+item.pageNumber+" 页 · ":"")+
              item.evidenceKey}
          </label>
          <p>{item.excerpt}</p>
        </li>)}
      </ul>
      {catalog&&matches.length===0&&<p className="empty-state">本页没有匹配证据，可清空过滤或翻页。</p>}
      <div className="button-row">
        <button type="button" disabled={busy||cases.length>=100}
          className="primary-button" onClick={addCase}>将问题和勾选证据加入标注集</button>
      </div>
      <p className="privacy-note">已创建 {cases.length}/100 条人工标注查询。
        每条至少 1 个相关证据才能参与评测；同一问题的全部相关证据应尽量标注完整。</p>
      <ul className="kb-review-list">
        {cases.map(entry=><li key={entry.id}>
          <span>{entry.id} · {entry.query}（{entry.relevant.length} 条相关证据）</span>
          <button type="button" className="text-button" disabled={busy}
            onClick={()=>setCases(previous=>previous.filter(c=>c.id!==entry.id))}>移除</button>
        </li>)}
      </ul>
      <button type="button" className="primary-button" disabled={busy||cases.length===0}
        onClick={()=>void save()}>保存人工标注为本机 JSON</button>
    </div>}
  </section>;
}
