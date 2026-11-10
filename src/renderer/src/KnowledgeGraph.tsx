import { useEffect,useState,type FormEvent } from "react";
import type { KnowledgeDocument,KnowledgePassage } from "../../shared/knowledge-model";
import type { KnowledgeGraphSnapshot,GraphNode,KnowledgeRelation } from "../../shared/knowledge-graph-model";

function errorMessage(e:unknown):string{return e instanceof Error?e.message:"知识图谱操作失败";}
const relationText:Record<KnowledgeRelation,string>={
  related:"相关",supports:"支持",contrasts:"对比/矛盾",
};
const empty:KnowledgeGraphSnapshot={nodes:[],edges:[]};

/** Explicitly human-curated graph. Neither the API nor this UI ever uploads content. */
export default function KnowledgeGraph({onOpenSource}:{
  onOpenSource:(documentId:string,ordinal:number)=>Promise<void>;
}){
  const [docs,setDocs]=useState<KnowledgeDocument[]>([]);
  const [graph,setGraph]=useState<KnowledgeGraphSnapshot>(empty);
  const [docId,setDocId]=useState("");
  const [ordinal,setOrdinal]=useState(0);
  const [source,setSource]=useState<KnowledgePassage|null>(null);
  const [title,setTitle]=useState("");
  const [note,setNote]=useState("");
  const [selectedId,setSelectedId]=useState("");
  const [editTitle,setEditTitle]=useState("");
  const [editNote,setEditNote]=useState("");
  const [from,setFrom]=useState("");
  const [to,setTo]=useState("");
  const [relation,setRelation]=useState<KnowledgeRelation>("related");
  const [edgeNote,setEdgeNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{
    let active=true;
    void Promise.all([window.desktop.knowledge.documents(),window.desktop.knowledge.graph()])
      .then(([items,snapshot])=>{
        if(!active)return;
        setDocs(items);setGraph(snapshot);
        setDocId(items[0]?.id??"");
      }).catch(e=>{if(active)setError(errorMessage(e));});
    return()=>{active=false;};
  },[]);
  async function refresh():Promise<void>{
    const snapshot=await window.desktop.knowledge.graph();
    setGraph(snapshot);
    setSelectedId(id=>snapshot.nodes.some(n=>n.id===id)?id:"");
  }
  async function run(work:()=>Promise<void>):Promise<void>{
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await work();}catch(e){setError(errorMessage(e));}
    finally{setBusy(false);}
  }
  function selectNode(node:GraphNode):void{
    setSelectedId(node.id);setEditTitle(node.title);setEditNote(node.note);
  }
  async function loadSource():Promise<void>{
    await run(async()=>{
      const result=await window.desktop.knowledge.passage(docId,ordinal);
      setSource(result);
      setNotice("已加载本机原文片段。请核对证据后再创建节点。");
    });
  }
  async function createNode(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(!source || source.documentId!==docId || source.ordinal!==ordinal)return;
    await run(async()=>{
      const node=await window.desktop.knowledge.createNode({
        documentId:docId,sourceOrdinal:ordinal,title,note,
      });
      await refresh();
      selectNode(node);
      setTitle("");setNote("");
      setNotice("已创建带原文来源的知识节点；未调用 AI，也未共享。");
    });
  }
  async function updateNode(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    if(!selectedId)return;
    await run(async()=>{
      const node=await window.desktop.knowledge.editNode({
        id:selectedId,title:editTitle,note:editNote,
      });
      await refresh();selectNode(node);
      setNotice("已修改人工注释，原文证据及版本标记保持不变。");
    });
  }
  async function deleteNode(node:GraphNode):Promise<void>{
    if(!window.confirm("删除该节点及所有关联边？资料和复习卡不会删除。"))return;
    await run(async()=>{
      await window.desktop.knowledge.deleteNode(node.id);
      await refresh();
      setSelectedId("");
      setNotice("节点和关联关系已删除。");
    });
  }
  async function createEdge(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    await run(async()=>{
      await window.desktop.knowledge.createEdge({
        sourceId:from,targetId:to,relation,note:edgeNote,
      });
      await refresh();setEdgeNote("");
      setNotice("已创建人工确认的关系边，证据由两端知识节点追溯。");
    });
  }
  async function deleteEdge(id:string):Promise<void>{
    if(!window.confirm("删除这条知识关系？"))return;
    await run(async()=>{
      await window.desktop.knowledge.deleteEdge(id);await refresh();
    });
  }

  const selected=graph.nodes.find(n=>n.id===selectedId);
  const currentDoc=docs.find(d=>d.id===docId);
  const visible=graph.nodes.slice(-24);
  const coords=new Map(visible.map((node,index)=>[
    node.id,{x:420+280*Math.cos(index*Math.PI*2/Math.max(visible.length,1)-Math.PI/2),
      y:275+195*Math.sin(index*Math.PI*2/Math.max(visible.length,1)-Math.PI/2)},
  ] as const));
  const shownEdges=graph.edges.filter(e=>coords.has(e.sourceId)&&coords.has(e.targetId));
  return <section className="kg-space">
    <div className="connector-warning" role="note">
      <strong>人工知识图谱：</strong>节点必须引用本地资料的实际原文片段，关系由你确认。
      图谱不调用 AI、不扫描文件、不上传网络。更新来源后旧节点会显示待核对，
      不能用过期资料建立新的关系。AI 待核验关系是未来扩展状态，当前不会自动生成。
    </div>
    {error&&<div className="error-banner" role="alert">{error}
      <button onClick={()=>setError("")}>关闭</button></div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    <div className="kg-layout">
      <section className="panel">
        <div className="eyebrow">SOURCE-ANCHORED NODES</div>
        <h2>从原文创建知识节点</h2>
        {docs.length===0?<p className="empty-state">请先在资料与搜索页面导入文档。</p>:
        <form className="kb-card-form" onSubmit={event=>void createNode(event)}>
          <label>来源文档<select value={docId} disabled={busy} onChange={e=>{
            setDocId(e.target.value);setOrdinal(0);setSource(null);
          }}>{docs.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
          <label>原文片段编号（从 1 开始）
            <input type="number" min={1} max={currentDoc?.chunkCount??1}
              disabled={busy} value={ordinal+1}
              onChange={e=>{setOrdinal(Number(e.target.value)-1);setSource(null);}}/>
          </label>
          <button className="secondary-button" type="button" disabled={busy||!docId}
            onClick={()=>void loadSource()}>读取并核对来源</button>
          {source&&source.documentId===docId&&source.ordinal===ordinal&&
          <div className="kg-evidence">
            <small>{source.documentTitle} · {source.pageNumber?`PDF 第 ${source.pageNumber} 页 · `:""}原文片段 #{source.ordinal+1} · 版本 {source.revision}</small>
            <p>{source.body.slice(0,600)}</p>
          </div>}
          <label>知识概念名称
            <input required maxLength={120} disabled={busy} value={title}
              placeholder="例如：DNA 复制" onChange={e=>setTitle(e.target.value)}/></label>
          <label>人工注释（可选）
            <textarea maxLength={600} rows={3} value={note} disabled={busy}
              onChange={e=>setNote(e.target.value)}/></label>
          <button className="primary-button" type="submit"
            disabled={busy||!source||source.documentId!==docId||source.ordinal!==ordinal}>
            建立带证据节点
          </button>
        </form>}
      </section>
      <section className="panel">
        <div className="eyebrow">MANUAL RELATIONS</div><h2>建立节点关系</h2>
        <form className="kb-card-form" onSubmit={event=>void createEdge(event)}>
          <label>起点节点<select value={from} required disabled={busy} onChange={e=>setFrom(e.target.value)}>
            <option value="">选择起点</option>
            {graph.nodes.map(n=><option key={n.id} value={n.id}>{n.title} · {n.documentTitle}{n.needsReview?"（待核对）":""}</option>)}
          </select></label>
          <label>关系<select value={relation} disabled={busy}
            onChange={e=>setRelation(e.target.value as KnowledgeRelation)}>
            {Object.entries(relationText).map(([v,label])=><option key={v} value={v}>{label}</option>)}
          </select></label>
          <label>终点节点<select value={to} required disabled={busy} onChange={e=>setTo(e.target.value)}>
            <option value="">选择终点</option>
            {graph.nodes.map(n=><option key={n.id} value={n.id}>{n.title} · {n.documentTitle}{n.needsReview?"（待核对）":""}</option>)}
          </select></label>
          <label>人工说明（可选）<textarea rows={3} maxLength={600}
            value={edgeNote} disabled={busy} onChange={e=>setEdgeNote(e.target.value)}/></label>
          <button className="primary-button" type="submit"
            disabled={busy||graph.nodes.length<2||!from||!to||from===to}>
            确认并创建关系
          </button>
        </form>
        <p className="privacy-note">来源文档不同也可关联，点击图谱节点可查看两侧来源。手工建立的关系为「已确认」，不是 AI 自动发现。</p>
      </section>
    </div>
    <section className="panel">
      <div className="panel-heading">
        <div><div className="eyebrow">LOCAL KNOWLEDGE MAP</div>
          <h2>知识图谱 · {graph.nodes.length} 个节点 / {graph.edges.length} 条关系</h2></div>
        <button className="secondary-button" disabled={busy} onClick={()=>void run(refresh)}>刷新图谱</button>
      </div>
      {visible.length===0?<p className="empty-state">尚无图谱节点。选一段原文创建第一个节点。</p>:
      <div className="kg-map-scroll">
        <svg viewBox="0 0 840 550" role="img" aria-label="个人知识节点与关系图" className="kg-map">
          {shownEdges.map(edge=>{
            const a=coords.get(edge.sourceId)!,b=coords.get(edge.targetId)!;
            const stale=graph.nodes.some(n=>(n.id===edge.sourceId||n.id===edge.targetId)&&n.needsReview);
            return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              className={stale?"kg-edge-stale":edge.status==="pending"?"kg-edge-pending":"kg-edge-confirmed"}/>;
          })}
          {visible.map(node=>{
            const p=coords.get(node.id)!;
            return <g key={node.id} className={node.needsReview?"kg-node-stale":"kg-node-current"}>
              <circle cx={p.x} cy={p.y} r={40}/>
              <text x={p.x} y={p.y-3} textAnchor="middle">{node.title.slice(0,8)}</text>
              <text x={p.x} y={p.y+15} textAnchor="middle" className="kg-node-sub">{node.documentTitle.slice(0,9)}</text>
            </g>;
          })}
        </svg>
      </div>}
      {graph.nodes.length>24&&<p className="privacy-note">图中仅显示最近的 24 个节点，下面的完整节点列表仍可操作。</p>}
      <div className="kg-legend"><span>实线：人工确认关系</span><span>虚线：AI 待核验（预留）</span><span>警示色：来源已变化</span></div>
    </section>
    <div className="kg-layout">
      <section className="panel">
        <h2>节点与证据</h2>
        <ul className="kb-document-list">{graph.nodes.map(node=><li key={node.id}>
          <button className={node.id===selectedId?"kb-doc-active":"kb-doc"}
            onClick={()=>selectNode(node)}>
            {node.title} {node.needsReview?"⚠️ 旧版证据待核验":""}
          </button>
          <small>{node.documentTitle} · {node.sourcePage?`PDF 第 ${node.sourcePage} 页 · `:""}片段 #{node.sourceOrdinal+1} · 来源 v{node.sourceRevision}</small>
        </li>)}</ul>
        {selected&&<div className="kg-selection">
          {selected.needsReview&&<p className="retention-warning">该资料已重新导入，证据来自旧版。请与当前原文比对；若有变化，删除并重建节点。</p>}
          <div className="kg-evidence"><strong>创建节点时保存的原文证据</strong><p>{selected.evidence}</p></div>
          <form className="kb-card-form" onSubmit={event=>void updateNode(event)}>
            <label>名称<input required maxLength={120} disabled={busy} value={editTitle}
              onChange={e=>setEditTitle(e.target.value)}/></label>
            <label>注释<textarea rows={2} maxLength={600} disabled={busy} value={editNote}
              onChange={e=>setEditNote(e.target.value)}/></label>
            <button type="submit" className="secondary-button" disabled={busy}>保存人工注释</button>
          </form>
          <div className="button-row">
            <button className="secondary-button" disabled={busy}
              onClick={()=>void onOpenSource(selected.documentId,selected.sourceOrdinal)}>在资料中查看当前原文</button>
            <button className="text-button" disabled={busy} onClick={()=>void deleteNode(selected)}>删除节点</button>
          </div>
        </div>}
      </section>
      <section className="panel">
        <h2>全部关系</h2>
        {graph.edges.length===0?<p className="empty-state">尚未建立关系，可以选两份文档中的不同节点进行关联。</p>:
        <ul className="kb-document-list">{graph.edges.map(edge=>{
          const a=graph.nodes.find(n=>n.id===edge.sourceId),b=graph.nodes.find(n=>n.id===edge.targetId);
          return <li key={edge.id}>
            <strong>{a?.title} — {relationText[edge.relation]} — {b?.title}</strong>
            <small>{a?.documentTitle} ↔ {b?.documentTitle} · {edge.status==="confirmed"?"人工已确认":"待核验"}
              {a?.needsReview||b?.needsReview?" · 原文已改变":""}</small>
            {edge.note&&<p>{edge.note}</p>}
            <button className="text-button" disabled={busy}
              onClick={()=>void deleteEdge(edge.id)}>删除关系</button>
          </li>;
        })}</ul>}
      </section>
    </div>
  </section>;
}
