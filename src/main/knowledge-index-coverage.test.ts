import {afterEach,describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {KnowledgeStore} from "./knowledge-store";
import {loadStaticWordVectors,staticWordVectorProvider} from "./knowledge-word-vectors";
import type {LocalEmbeddingProvider} from "./knowledge-embeddings";

const WORDS=`4 3
energy 1 0 0
mitochondria 0.9 0.1 0
能量 1 0 0
calculus 0 0 1
`;
const provider=()=>staticWordVectorProvider(loadStaticWordVectors(Buffer.from(WORDS)));
const directories:string[]=[];
const stores:KnowledgeStore[]=[];
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-coverage-"));
  directories.push(dir);
  const path=join(dir,"knowledge.sqlite");
  const store=new KnowledgeStore(path);
  stores.push(store);return {dir,path,store};
}
function dispose(store:KnowledgeStore){
  const i=stores.indexOf(store);
  if(i>=0)stores.splice(i,1);
  store.close();
}
async function finish(store:KnowledgeStore,embedding:LocalEmbeddingProvider){
  let steps=0;
  while(true){
    if(steps++>20)throw Error("Index retry loop failed to converge");
    const next=store.nextEmbeddingTarget();
    if(!next)return;
    await store.indexEmbeddingBatch(embedding,next.documentId,next.revision,next.ordinal);
  }
}
afterEach(()=>{
  while(stores.length)try{stores.pop()!.close();}catch{/* closed */}
  while(directories.length)rmSync(directories.pop()!,{recursive:true,force:true});
});

describe("ALPHA-KB-005C durable vocabulary coverage and safe recovery",()=>{
  it("skips an unknown document, continues known documents and persists exact counters",async()=>{
    const {store,path}=fixture(),model=provider();
    const unknown=store.importText({sourcePath:"/unknown.md",title:"Unknown",
      format:"markdown",text:"astrophysics telescopes nebulae"}).document;
    const known=store.importText({sourcePath:"/known.md",title:"Biology",
      format:"markdown",text:"Mitochondria produce energy"}).document;
    const second=store.importText({sourcePath:"/second.md",title:"Math",
      format:"markdown",text:"calculus calculus"}).document;
    store.configureLocalEmbeddingModel(model.model);
    expect(store.embeddingStatus()).toMatchObject({total:3,indexed:0,skipped:0,pending:3});
    await finish(store,model);
    expect(store.embeddingStatus()).toMatchObject({total:3,indexed:2,skipped:1,pending:0});
    expect(store.nextEmbeddingTarget()).toBeNull();
    const unknownSearch=await store.searchWithEmbeddings("nebulae",model);
    expect(unknownSearch[0]).toMatchObject({documentId:unknown.id,matchType:"exact"});
    const sem=await store.searchWithEmbeddings("energy",model);
    expect(sem.some(x=>x.documentId===known.id)).toBe(true);
    expect(sem.every(x=>x.documentId!==unknown.id)).toBe(true);
    const db=new DatabaseSync(path,{readOnly:true});
    const row=db.prepare("SELECT reason FROM knowledge_vector_skips").get() as {reason:string};
    expect(row.reason).toBe("vocabulary_miss");
    expect((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)
      .toBe(6);
    db.close();
    expect(unknown.id).not.toBe(second.id);
    dispose(store);
    const again=new KnowledgeStore(path);stores.push(again);
    expect(again.embeddingStatus()).toMatchObject({indexed:2,skipped:1,pending:0});
    expect(again.nextEmbeddingTarget()).toBeNull();
  });

  it("commits known and unknown passages in one atomic batch with distinct outcomes",async()=>{
    const {store}=fixture(),model=provider();
    const doc=store.importPdf({format:"pdf",sourcePath:"/mixed.pdf",
      title:"Mixed",pages:["Mitochondria energy","unfamiliar nebulae telescopes"],
      fileHash:"a".repeat(64),byteLength:128}).document;
    store.configureLocalEmbeddingModel(model.model);
    expect(await store.indexEmbeddingBatch(model,doc.id,doc.revision,0))
      .toMatchObject({written:1});
    expect(store.embeddingStatus()).toMatchObject({indexed:1,skipped:1,pending:0,total:2});
    expect(store.nextEmbeddingTarget()).toBeNull();
  });

  it("does not turn arbitrary worker errors into vocabulary misses",async()=>{
    const {store}=fixture(),model=provider();
    store.importText({sourcePath:"/one.md",title:"One",format:"markdown",
      text:"unknownwordsunrecognized"}).document;
    store.configureLocalEmbeddingModel(model.model);
    const bad:LocalEmbeddingProvider={model:model.model,
      async embed(){throw Error("Inference worker crashed");},
      async embedPassages(){throw Error("Inference worker crashed");}};
    const target=store.nextEmbeddingTarget()!;
    await expect(store.indexEmbeddingBatch(bad,target.documentId,target.revision))
      .rejects.toThrow("crashed");
    expect(store.embeddingStatus()).toMatchObject({indexed:0,skipped:0,pending:1});
    expect(store.nextEmbeddingTarget()).not.toBeNull();
  });

  it("rolls back every row on an invalid result or cancelled mixed batch",async()=>{
    const {store}=fixture(),model=provider();
    const doc=store.importPdf({format:"pdf",sourcePath:"/rollback.pdf",
      title:"Rollback",pages:["Mitochondria energy","unfamiliar nebulae"],
      fileHash:"b".repeat(64),byteLength:70}).document;
    store.configureLocalEmbeddingModel(model.model);
    const invalid:LocalEmbeddingProvider={model:model.model,
      async embed(){return [];},
      async embedPassages(){return [[1,0,0],[Number.NaN,0,0]];}};
    await expect(store.indexEmbeddingBatch(invalid,doc.id,doc.revision,0))
      .rejects.toThrow("coordinate");
    expect(store.embeddingStatus()).toMatchObject({indexed:0,skipped:0,pending:2});
    await expect(store.indexEmbeddingBatch(model,doc.id,doc.revision,0,()=>true))
      .rejects.toThrow("canceled");
    expect(store.embeddingStatus()).toMatchObject({indexed:0,skipped:0,pending:2});
    await finish(store,model);
    expect(store.embeddingStatus()).toMatchObject({indexed:1,skipped:1,pending:0});
  });

  it("drops stale skips after reimport and rechecks coverage under a new revision",async()=>{
    const {store}=fixture(),model=provider();
    const old=store.importText({sourcePath:"/revision.md",title:"Revision",
      format:"markdown",text:"undefinedwordendless"}).document;
    store.configureLocalEmbeddingModel(model.model);
    await finish(store,model);
    expect(store.embeddingStatus()).toMatchObject({skipped:1,pending:0});
    const updated=store.importText({sourcePath:"/revision.md",title:"Revision",
      format:"markdown",text:"mitochondria energy"}).document;
    expect(updated.id).toBe(old.id);
    expect(updated.revision).toBe(2);
    expect(store.embeddingStatus()).toMatchObject({indexed:0,skipped:0,pending:1});
    await finish(store,model);
    expect(store.embeddingStatus()).toMatchObject({indexed:1,skipped:0,pending:0});
    expect(store.deleteDocument(old.id)).toBe(true);
    expect(store.embeddingStatus()).toMatchObject({indexed:0,skipped:0,total:0});
  });

  it("clears skipped state on model change and uninstall without touching source",async()=>{
    const {store}=fixture(),model=provider();
    store.importText({sourcePath:"/another.md",title:"Another",
      format:"markdown",text:"completelyunseen"}).document;
    store.configureLocalEmbeddingModel(model.model);
    await finish(store,model);
    expect(store.embeddingStatus()).toMatchObject({skipped:1,pending:0});
    const next={...model.model,revision:"f".repeat(64)};
    store.configureLocalEmbeddingModel(next);
    expect(store.embeddingStatus()).toMatchObject({model:next,skipped:0,pending:1});
    store.clearLocalEmbeddings();
    expect(store.embeddingStatus()).toMatchObject({model:null,skipped:0,indexed:0,total:1});
  });

  it("migrates an existing v4 file without destroying indexed vectors or documents",async()=>{
    const {store,path}=fixture(),model=provider();
    store.importText({sourcePath:"/old.md",title:"Legacy",
      format:"markdown",text:"mitochondria energy"}).document;
    store.configureLocalEmbeddingModel(model.model);
    await finish(store,model);
    dispose(store);
    const db=new DatabaseSync(path);
    db.exec("DROP TABLE knowledge_card_evidence_history; DROP TABLE knowledge_vector_skips; PRAGMA user_version=4");
    db.close();
    const migrated=new KnowledgeStore(path);stores.push(migrated);
    expect(migrated.embeddingStatus()).toMatchObject({indexed:1,skipped:0,pending:0});
    expect(migrated.search("energy")).toHaveLength(1);
  });
});
