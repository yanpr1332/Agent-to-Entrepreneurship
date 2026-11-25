import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {KnowledgeStore} from "./knowledge-store";
import type {LocalEmbeddingProvider} from "./knowledge-embeddings";

const VERSION="a".repeat(64);
const MODEL={id:"example/offline-test-encoder",revision:VERSION,
  dimension:3,format:"float32-l2" as const,protocol:"passage-query-v1" as const};
const roots:string[]=[],stores:KnowledgeStore[]=[];
const fixture=()=>{
  const root=mkdtempSync(join(tmpdir(),"study-anchor-vectors-"));roots.push(root);
  const path=join(root,"knowledge.sqlite");
  const store=new KnowledgeStore(path);stores.push(store);
  return {path,store};
};
function close(store:KnowledgeStore){
  store.close();
  stores.splice(stores.indexOf(store),1);
}
/** Synthetic *test-only* vocabulary. NOT a real embedding model: it proves
 * local indexing, quote matching, source revisions and rank fusion. */
const embedText=(value:string):number[]=>{
  if(/ATP|energy|能量|mitochondria/i.test(value))return [1,0,0];
  if(/photosynthesis|光合作用|叶绿体/i.test(value))return [0,1,0];
  if(/calculus|导数|微积分/i.test(value))return [0,0,1];
  return [.01,.01,.01];
};
function encoder(model=MODEL):LocalEmbeddingProvider{
  return {model,async embed(texts){return texts.map(embedText);}};
}
const importText=(store:KnowledgeStore,path:string,title:string,text:string)=>
  store.importText({sourcePath:path,title,format:"markdown",text}).document;

afterEach(()=>{
  while(stores.length){try{stores.pop()!.close();}catch{/* already closed */}}
  while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});
});

describe("ALPHA-KB-005A persisted local vectors and revision-safe search",()=>{
  it("keeps original exact/fuzzy results when no local model is installed",async()=>{
    const {store}=fixture();
    importText(store,"/science.md","Science","Mitochondria create ATP energy.");
    expect(store.embeddingStatus()).toMatchObject({model:null,indexed:0,total:1});
    const original=store.search("energy");
    expect(await store.searchWithEmbeddings("energy",null)).toEqual(original);
    expect(await store.searchWithEmbeddings("energy",encoder())).toEqual(original);
  });

  it("indexes two documents, recovers the index across restart, and preserves exact priority",async()=>{
    const {path,store}=fixture();
    const a=importText(store,"/english.md","Energy","Mitochondria produce ATP energy.");
    const b=importText(store,"/chinese.md","中文生物","线粒体将养分转化为能量。");
    store.configureLocalEmbeddingModel(MODEL);
    expect(await store.indexEmbeddingBatch(encoder(),a.id,1,0))
      .toEqual({written:1,nextOrdinal:null});
    expect(await store.indexEmbeddingBatch(encoder(),b.id,1,0))
      .toEqual({written:1,nextOrdinal:null});
    expect(store.embeddingStatus()).toMatchObject({indexed:2,total:2});
    const result=await store.searchWithEmbeddings("energy",encoder());
    expect(result[0]).toMatchObject({documentId:a.id,matchType:"exact"});
    expect(result.some(x=>x.documentId===b.id&&x.matchType==="semantic")).toBe(true);
    close(store);
    const fresh=new KnowledgeStore(path);stores.push(fresh);
    expect(fresh.embeddingStatus()).toMatchObject({indexed:2,total:2});
    expect((await fresh.searchWithEmbeddings("energy",encoder()))[0].documentId).toBe(a.id);
    const sqlite=new DatabaseSync(path,{readOnly:true});
    const header=sqlite.prepare("PRAGMA user_version").get() as {user_version:number};
    const saved=sqlite.prepare("SELECT vector,dimension FROM knowledge_vectors LIMIT 1")
      .get() as {vector:Buffer;dimension:number};
    expect(header.user_version).toBe(5);
    expect(saved.dimension).toBe(3);
    expect(saved.vector).toHaveLength(12);
    sqlite.close();
  });

  it("keeps correct PDF page references for semantic-only results",async()=>{
    const {store}=fixture();
    const pdf=store.importPdf({format:"pdf",sourcePath:"/biology.pdf",
      title:"Biology workbook",pages:["Photosynthesis requires sunlight.",
        "ATP synthesis occurs in mitochondria."],
      fileHash:"a".repeat(64),byteLength:80}).document;
    store.configureLocalEmbeddingModel(MODEL);
    await store.indexEmbeddingBatch(encoder(),pdf.id,1);
    const hits=await store.searchWithEmbeddings("energy",encoder());
    expect(hits.some(x=>x.documentId===pdf.id&&x.pageNumber===2&&
      x.matchType==="semantic")).toBe(true);
  });

  it("clears prior vectors when model revision or dimension changes",async()=>{
    const {store}=fixture();
    const doc=importText(store,"/notes.md","Notes","ATP energy is stored");
    store.configureLocalEmbeddingModel(MODEL);
    await store.indexEmbeddingBatch(encoder(),doc.id,1);
    const next={...MODEL,revision:"b".repeat(64)};
    store.configureLocalEmbeddingModel(next);
    expect(store.embeddingStatus()).toMatchObject({model:next,indexed:0,total:1});
    await expect(store.indexEmbeddingBatch(encoder(),doc.id,1)).rejects
      .toThrow("not configured");
    expect(await store.searchWithEmbeddings("energy",encoder()))
      .toEqual(store.search("energy"));
    store.clearLocalEmbeddings();
    expect(store.embeddingStatus()).toMatchObject({model:null,indexed:0});
    expect(store.search("ATP")).toHaveLength(1);
  });

  it("removes deleted passages via FK and invalidates changed revisions",async()=>{
    const {path,store}=fixture();
    const doc=importText(store,"/lab.md","Lab","ATP energy is stored in cells");
    store.configureLocalEmbeddingModel(MODEL);
    await store.indexEmbeddingBatch(encoder(),doc.id,1);
    expect(store.embeddingStatus().indexed).toBe(1);
    const revised=importText(store,"/lab.md","Lab","Photosynthesis occurs in leaves");
    expect(revised.revision).toBe(2);
    expect(store.embeddingStatus().indexed).toBe(0);
    expect((await store.searchWithEmbeddings("energy",encoder())).some(x=>x.documentId===doc.id))
      .toBe(false);
    await store.indexEmbeddingBatch(encoder(),doc.id,2);
    expect(store.embeddingStatus().indexed).toBe(1);
    expect(store.deleteDocument(doc.id)).toBe(true);
    expect(store.embeddingStatus()).toMatchObject({indexed:0,total:0});
    const sqlite=new DatabaseSync(path,{readOnly:true});
    expect((sqlite.prepare("SELECT count(*) AS n FROM knowledge_vectors").get() as {n:number}).n)
      .toBe(0);
    sqlite.close();
  });

  it("discards an in-flight indexing batch after source revision changes",async()=>{
    const {store}=fixture();
    const old=importText(store,"/changing.md","Changing","ATP energy review");
    store.configureLocalEmbeddingModel(MODEL);
    let resolve:(rows:readonly number[][])=>void=()=>{};
    let started:()=>void=()=>{};
    const begun=new Promise<void>(r=>{started=r;});
    const slow:LocalEmbeddingProvider={model:MODEL,embed:()=>new Promise(r=>{
      resolve=r;started();
    })};
    const pending=store.indexEmbeddingBatch(slow,old.id,old.revision);
    await begun;
    importText(store,"/changing.md","Changing","Calculus derivatives");
    resolve([[1,0,0]]);
    await expect(pending).rejects.toThrow("changed during local indexing");
    expect(store.embeddingStatus().indexed).toBe(0);
  });

  it("rejects missing vectors, poisoned nonfinite values, and leaves zero partial inserts",async()=>{
    const {store}=fixture();
    const doc=importText(store,"/safe.md","Safe","ATP energy note");
    store.configureLocalEmbeddingModel(MODEL);
    const short:LocalEmbeddingProvider={model:MODEL,async embed(){return [];}};
    await expect(store.indexEmbeddingBatch(short,doc.id,1))
      .rejects.toThrow("incomplete embedding batch");
    const bad:LocalEmbeddingProvider={model:MODEL,
      async embed(){return [[1,Number.NaN,0]];}};
    await expect(store.indexEmbeddingBatch(bad,doc.id,1))
      .rejects.toThrow("Invalid embedding coordinate");
    expect(store.embeddingStatus().indexed).toBe(0);
    expect(await store.searchWithEmbeddings("ATP",bad)).toEqual(store.search("ATP"));
  });

  it("upgrades an actual pre-vector v3 knowledge database without losing other data",()=>{
    const {path,store}=fixture();
    importText(store,"/archive.md","Archive","Local import survives");
    close(store);
    const old=new DatabaseSync(path);
    old.exec("DROP TABLE knowledge_card_evidence_history; DROP TABLE knowledge_vector_skips; DROP TABLE knowledge_vectors; DROP TABLE knowledge_vector_config; PRAGMA user_version=3");
    old.close();
    const reopened=new KnowledgeStore(path);stores.push(reopened);
    expect(reopened.embeddingStatus()).toMatchObject({model:null,indexed:0,total:1});
    expect(reopened.search("survives")).toHaveLength(1);
  });
});
