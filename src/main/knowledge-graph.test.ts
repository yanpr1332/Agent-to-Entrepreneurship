import {afterEach,describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {mkdtempSync,rmSync} from "node:fs";
import {KnowledgeStore} from "./knowledge-store";
import {backupBeforeMigration} from "./local-backup";

const stores:KnowledgeStore[]=[];
const folders:string[]=[];
function memory(){const store=new KnowledgeStore(":memory:");stores.push(store);return store;}
const a={sourcePath:"/tmp/graph-alpha.md",title:"Alpha",format:"markdown" as const,
  text:"Graph alpha source excerpt with biological facts."};
const b={sourcePath:"/tmp/graph-beta.txt",title:"Beta",format:"text" as const,
  text:"Graph beta source excerpt with chemical facts."};
function nodeInput(documentId:string,title:string){
  return {documentId,sourceOrdinal:0,expectedRevision:1,title,note:"manually verified"};
}
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  for(const path of folders.splice(0))rmSync(path,{recursive:true,force:true});
});

describe("source-cited local knowledge graph v3",()=>{
  it("creates cross-document manually confirmed relations and preserves exact evidence",()=>{
    const store=memory();
    const da=store.importText(a).document,db=store.importText(b).document;
    const na=store.createGraphNode(nodeInput(da.id,"DNA")),nb=store.createGraphNode(nodeInput(db.id,"ATP"));
    expect(na).toMatchObject({documentId:da.id,sourceOrdinal:0,sourceRevision:1,needsReview:false});
    expect(na.evidence).toContain("biological facts");
    const edge=store.createGraphEdge({sourceId:na.id,targetId:nb.id,relation:"related",note:"human note"});
    expect(edge.status).toBe("confirmed");
    expect(store.graph().nodes.map(n=>n.id).sort()).toEqual([na.id,nb.id].sort());
    expect(store.graph().edges.map(e=>e.id)).toEqual([edge.id]);
    expect(store.createGraphNode(nodeInput(da.id,"DNA")).id).toBe(na.id);
    expect(store.createGraphEdge({sourceId:na.id,targetId:nb.id,relation:"related",note:"human note"}).id)
      .toBe(edge.id);
    const edited=store.editGraphNode({id:na.id,title:"DNA Replication",note:"rephrased"});
    expect(edited.title).toBe("DNA Replication");
    expect(edited.evidence).toBe(na.evidence);
    expect(edited.sourceHash).toBe(na.sourceHash);
    expect(store.deleteGraphEdge(edge.id)).toBe(true);
    expect(store.graph().edges).toHaveLength(0);
  });
  it("rejects arbitrary or forged fields, invalid passages and missing node identities",()=>{
    const store=memory(),doc=store.importText(a).document;
    expect(()=>store.createGraphNode({...nodeInput(doc.id,"N"),sourcePath:"/tmp/secrets"})).toThrow();
    expect(()=>store.createGraphNode({...nodeInput(doc.id,"N"),sourceOrdinal:9999})).toThrow();
    expect(()=>store.createGraphNode({...nodeInput(doc.id,"N"),sourceOrdinal:1})).toThrow();
    expect(()=>store.createGraphNode({...nodeInput(doc.id,"N"),note:"\x00"})).toThrow();
    const n=store.createGraphNode(nodeInput(doc.id,"N"));
    expect(()=>store.createGraphEdge({sourceId:n.id,targetId:n.id,relation:"related",note:""})).toThrow();
    expect(()=>store.createGraphEdge({sourceId:n.id,targetId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",relation:"related",note:""})).toThrow();
    expect(()=>store.createGraphEdge({sourceId:n.id,targetId:n.id,relation:"invented",note:""})).toThrow();
    expect(()=>store.editGraphNode({id:n.id,title:"new title",note:"",evidence:"spoof"})).toThrow();
  });
  it("marks obsolete evidence on source reimport and prevents new links to stale nodes",()=>{
    const store=memory();
    const da=store.importText(a).document,db=store.importText(b).document;
    const na=store.createGraphNode(nodeInput(da.id,"Old DNA"));
    const nb=store.createGraphNode(nodeInput(db.id,"Other concept"));
    store.importText({...a,text:"Completely revised evidence about mitochondria."});
    const stale=store.graph().nodes.find(n=>n.id===na.id)!;
    expect(stale.needsReview).toBe(true);
    expect(stale.evidence).toContain("biological facts");
    expect(stale.sourceHash).toBe(da.contentHash);
    expect(()=>store.createGraphEdge({sourceId:na.id,targetId:nb.id,relation:"supports",note:""}))
      .toThrow("stale");
    expect(()=>store.createGraphNode(nodeInput(da.id,"New DNA"))).toThrow("source changed");
    const newer=store.createGraphNode({...nodeInput(da.id,"New DNA"),expectedRevision:2});
    expect(newer.sourceRevision).toBe(2);
    expect(newer.needsReview).toBe(false);
    expect(store.createGraphEdge({sourceId:newer.id,targetId:nb.id,relation:"related",note:""}))
      .toMatchObject({status:"confirmed"});
  });
  it("removes dependent edges when a document/node is deleted without touching other documents",()=>{
    const store=memory();
    const da=store.importText(a).document,db=store.importText(b).document;
    const na=store.createGraphNode(nodeInput(da.id,"N1"));
    const nb=store.createGraphNode(nodeInput(db.id,"N2"));
    store.createGraphEdge({sourceId:na.id,targetId:nb.id,relation:"related",note:""});
    expect(store.deleteDocument(da.id)).toBe(true);
    expect(store.graph().nodes).toHaveLength(1);
    expect(store.graph().edges).toHaveLength(0);
    expect(store.graph().nodes[0].id).toBe(nb.id);
    expect(store.deleteGraphNode(nb.id)).toBe(true);
    expect(store.graph().nodes).toEqual([]);
  });
  it("backs up v2 data before v3 schema migration and retains old review cards",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-graph-v2-"));folders.push(dir);
    const path=join(dir,"ate-knowledge.sqlite");
    const first=new KnowledgeStore(path);
    const doc=first.importText(a).document;
    const card=first.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"What is discussed?",answer:"Biology."});
    first.close();
    const old=new DatabaseSync(path);
    old.exec(`DROP TABLE knowledge_graph_edges; DROP TABLE knowledge_graph_nodes; PRAGMA user_version=2;`);
    old.close();
    const folder=await backupBeforeMigration(dir,"ate-knowledge.sqlite",3);
    expect(folder).toBeTruthy();
    const original=new DatabaseSync(join(folder!,"ate-knowledge.sqlite"),{readOnly:true});
    expect((original.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
    original.close();
    const restored=new KnowledgeStore(path);
    expect(restored.listDocuments()[0].id).toBe(doc.id);
    expect(restored.listCards()[0].id).toBe(card.id);
    expect(restored.createGraphNode(nodeInput(doc.id,"Restored")).sourceRevision).toBe(1);
    restored.close();
  });
});
