import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,
  rmSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {KnowledgeStore} from "./knowledge-store";
import {KnowledgeOfflineModels} from "./knowledge-offline-models";
import {readStaticWordVectors,staticWordVectorProvider} from "./knowledge-word-vectors";
import type {LocalEmbeddingModel,LocalEmbeddingProvider} from "./knowledge-embeddings";

const modelText=`6 3
mitochondria 1 0 0
energy 1 0 0
atp 1 0.2 0
线粒体 1 0 0
能量 1 0 0
calculus 0 0 1
`;
type Handle=LocalEmbeddingProvider&{close():void};
const makeProvider=async(path:string,model:LocalEmbeddingModel):Promise<Handle>=>{
  const real=staticWordVectorProvider(readStaticWordVectors(path));
  if(real.model.revision!==model.revision)throw Error("Model SHA mismatch");
  return {...real,close(){}};
};
const dirs:string[]=[];
const dbs:KnowledgeStore[]=[];
const services:KnowledgeOfflineModels[]=[];
const setup=()=>{
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-offline-"));dirs.push(dir);
  const store=new KnowledgeStore(join(dir,"knowledge.sqlite"));dbs.push(store);
  const source=join(dir,"user-supplied.vec");
  writeFileSync(source,modelText);
  const manager=new KnowledgeOfflineModels(dir,store,makeProvider);services.push(manager);
  return {dir,store,source,manager};
};
async function finish(manager:KnowledgeOfflineModels){
  for(let i=0;i<100;i++){
    if(!manager.status().running)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error("Timed out waiting for local vector indexing");
}
afterEach(()=>{
  while(services.length)services.pop()!.close();
  while(dbs.length)dbs.pop()!.close();
  while(dirs.length)rmSync(dirs.pop()!,{force:true,recursive:true});
});
describe("ALPHA-KB-005B opt-in offline model workflow",()=>{
  it("imports a true static vector file, builds in bounded batches, persists and restores offline",async()=>{
    const {dir,store,manager,source}=setup();
    const english=store.importText({sourcePath:"/english.md",title:"English",
      format:"markdown",text:"Mitochondria produce ATP energy."}).document;
    const chinese=store.importText({sourcePath:"/zh.md",title:"Chinese",
      format:"markdown",text:"线粒体产生能量。"}).document;
    expect(manager.status()).toMatchObject({installed:false,model:null,indexed:0});
    expect(await manager.search("energy")).toEqual(store.search("energy"));
    const imported=await manager.importFile(source);
    expect(imported).toMatchObject({installed:true,running:false,indexed:0,total:2});
    expect(imported.model?.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(store.nextEmbeddingTarget()).not.toBeNull();
    const record=JSON.parse(readFileSync(join(dir,"knowledge-models","installed.json"),"utf8"));
    expect(record.file).toBe(imported.model!.revision+".vec");
    manager.startIndex();
    await finish(manager);
    expect(manager.status()).toMatchObject({installed:true,indexed:2,total:2,
      running:false,error:null});
    const hits=await manager.search("energy");
    expect(hits[0]).toMatchObject({documentId:english.id,matchType:"exact"});
    expect(hits.some(h=>h.documentId===chinese.id&&h.matchType==="semantic"))
      .toBe(true);
    manager.close();
    services.splice(services.indexOf(manager),1);
    store.close();dbs.splice(dbs.indexOf(store),1);
    const disk=new KnowledgeStore(join(dir,"knowledge.sqlite"));dbs.push(disk);
    const revived=new KnowledgeOfflineModels(dir,disk,makeProvider);services.push(revived);
    await revived.restore();
    expect(revived.status()).toMatchObject({installed:true,indexed:2});
    expect((await revived.search("energy")).some(h=>h.documentId===chinese.id&&
      h.matchType==="semantic")).toBe(true);
  });

  it("only deletes the managed model copy and derived index, preserving original user file",async()=>{
    const {dir,manager,store,source}=setup();
    store.importText({sourcePath:"/science.md",title:"Science",
      format:"markdown",text:"ATP energy is conserved."});
    await manager.importFile(source);
    manager.startIndex();await finish(manager);
    const old=manager.status().model!;
    const status=manager.remove();
    expect(status).toMatchObject({installed:false,indexed:0,model:null});
    expect(store.search("ATP")).toHaveLength(1);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(dir,"knowledge-models",old.revision+".vec"))).toBe(false);
    expect(existsSync(join(dir,"knowledge-models","installed.json"))).toBe(false);
  });

  it("ignores corrupted manifests without touching knowledge text or model bytes",async()=>{
    const {dir,manager,store,source}=setup();
    store.importText({sourcePath:"/science.md",title:"Science",
      format:"markdown",text:"Mitochondria ATP"});
    await manager.importFile(source);
    manager.close();services.splice(services.indexOf(manager),1);
    writeFileSync(join(dir,"knowledge-models","installed.json"),"INVALID");
    const restarted=new KnowledgeOfflineModels(dir,store,makeProvider);services.push(restarted);
    await restarted.restore();
    expect(restarted.status()).toMatchObject({installed:false,engine:null});
    expect(restarted.status().error).toContain("安全退回");
    expect(store.search("ATP")).toHaveLength(1);
  });

  it("blocks invalid and symlink model sources without replacing active verified model",async()=>{
    const {dir,manager,source}=setup();
    const old=await manager.importFile(source);
    const broken=join(dir,"malformed.vec");
    writeFileSync(broken,"javascript: alert('bad')");
    await expect(manager.importFile(broken)).rejects.toThrow();
    const link=join(dir,"symlink.vec");
    try{symlinkSync(source,link);}catch{return;} // symlinks may require Windows privileges
    await expect(manager.importFile(link)).rejects.toThrow("Unsupported");
    expect(manager.status().model).toEqual(old.model);
    expect(manager.status().installed).toBe(true);
  });

  it("stops an in-flight batch before SQLite commit and resumes on the next start",async()=>{
    const {store,manager,source}=setup();
    const doc=store.importText({sourcePath:"/new.md",title:"New",
      format:"markdown",text:"ATP energy"}).document;
    await manager.importFile(source);
    let release:(v:readonly number[][])=>void=()=>{};
    const awaiting=new Promise<readonly number[][]>(r=>{release=r;});
    const standIn:LocalEmbeddingProvider={model:manager.status().model!,
      embed:vi.fn(()=>awaiting)};
    const inFlight=store.indexEmbeddingBatch(standIn,doc.id,doc.revision,0,()=>true);
    release([[1,0,0]]);
    await expect(inFlight).rejects.toThrow("canceled");
    expect(store.embeddingStatus().indexed).toBe(0);
    manager.startIndex();await finish(manager);
    expect(store.embeddingStatus().indexed).toBe(1);
  });

  it("does not read any remote model URL or silently run indexing on import",async()=>{
    const {dir,manager,source}=setup();
    const status=await manager.importFile(source);
    expect(status.indexed).toBe(0);
    expect(status.running).toBe(false);
    expect(readFileSync(join(dir,"knowledge-models","installed.json"),"utf8"))
      .not.toContain("http");
  });
});
