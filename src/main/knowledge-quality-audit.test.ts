import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {KnowledgeStore} from "./knowledge-store";
import {KnowledgeOfflineModels} from "./knowledge-offline-models";
import {
  parseLocalEvaluationLabels,readLocalEvaluationLabels,
  evaluateLocalRetrieval,
} from "./knowledge-quality-audit";
import {staticWordVectorProvider,readStaticWordVectors} from "./knowledge-word-vectors";
import type {LocalEmbeddingModel} from "./knowledge-embeddings";
import type {KnowledgeSearchHit} from "../shared/knowledge-model";
const ID="00000000-0000-4000-8000-000000000001";
const VECTORS=`4 3
mitochondria 1 0 0
energy 1 0 0
线粒体 1 0 0
calculus 0 0 1
`;
const dirs:string[]=[],stores:KnowledgeStore[]=[],managers:KnowledgeOfflineModels[]=[];
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-eval-"));dirs.push(dir);
  const store=new KnowledgeStore(join(dir,"knowledge.sqlite"));stores.push(store);
  const modelPath=join(dir,"local.vec");
  writeFileSync(modelPath,VECTORS);
  const manager=new KnowledgeOfflineModels(dir,store,
    async(path:string,expected:LocalEmbeddingModel)=>{
      const actual=staticWordVectorProvider(readStaticWordVectors(path));
      if(actual.model.revision!==expected.revision)
        throw Error("Test model SHA mismatch");
      return {...actual,close(){}};
    });
  managers.push(manager);
  return {dir,store,modelPath,manager};
}
async function index(store:KnowledgeStore,manager:KnowledgeOfflineModels){
  const model=staticWordVectorProvider(readStaticWordVectors(
    join((manager as unknown as {directory:string}).directory,
      manager.status().model!.revision+".vec")));
  for(let i=0;i<15;i++){
    const next=store.nextEmbeddingTarget();if(!next)break;
    await store.indexEmbeddingBatch(model,next.documentId,next.revision,next.ordinal);
  }
}
afterEach(()=>{
  while(managers.length)managers.pop()!.close();
  while(stores.length)stores.pop()!.close();
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});
describe("ALPHA-KB-005C user-labelled local search evaluation",()=>{
  it("validates bounded labels, exact schema and canonical source evidence keys",()=>{
    const label={schema:1,cases:[{id:"zh-energy",query:"线粒体能量",
      relevant:[ID+":1:0"]}]};
    expect(parseLocalEvaluationLabels(label)).toEqual(label.cases);
    for(const incorrect of [
      {...label,schema:2},
      {...label,remoteUrl:"https://example.com"},
      {...label,cases:[{...label.cases[0],query:""}]},
      {...label,cases:[{...label.cases[0],relevant:[]}]},
      {...label,cases:[{...label.cases[0],relevant:[ID+":0:0"]}]},
      {...label,cases:[{...label.cases[0],relevant:[ID+":1:99999"]}]},
      {...label,cases:[label.cases[0],label.cases[0]]},
      {...label,cases:[{...label.cases[0],relevant:[ID+":1:0",ID+":1:0"]}]},
    ])expect(()=>parseLocalEvaluationLabels(incorrect)).toThrow();
  });

  it("refuses symlinked, oversized and malformed JSON files",()=>{
    const {dir}=fixture(),valid=join(dir,"labels.json");
    writeFileSync(valid,JSON.stringify({schema:1,cases:[
      {id:"x",query:"energy",relevant:[ID+":1:0"]}]}));
    expect(readLocalEvaluationLabels(valid)).toHaveLength(1);
    const link=join(dir,"symlink.json");
    try{
      symlinkSync(valid,link);
      expect(()=>readLocalEvaluationLabels(link)).toThrow();
    }catch(error){
      if(!(error instanceof Error&&/EPERM|EACCES/.test(error.message)))throw error;
    }
    const tooLarge=join(dir,"huge.json");
    writeFileSync(tooLarge," ".repeat(128*1024+1));
    expect(()=>readLocalEvaluationLabels(tooLarge)).toThrow("oversized");
    writeFileSync(valid,"{garbled");
    expect(()=>readLocalEvaluationLabels(valid)).toThrow();
  });

  it("evaluates actual local vocabulary retrieval versus lexical results without any cloud request",async()=>{
    const {dir,store,manager,modelPath}=fixture();
    const en=store.importText({sourcePath:"/en.md",title:"Energy",
      format:"markdown",text:"Mitochondria use energy"}).document;
    const zh=store.importText({sourcePath:"/zh.md",title:"中文",
      format:"markdown",text:"线粒体产生能量"}).document;
    await manager.importFile(modelPath);
    await index(store,manager);
    expect(manager.status()).toMatchObject({indexed:2,skipped:0,pending:0});
    const file=join(dir,"labels.json");
    writeFileSync(file,JSON.stringify({schema:1,cases:[
      {id:"energy-zh",query:"energy",relevant:[en.id+":1:0",zh.id+":1:0"]},
      {id:"energy-en",query:"mitochondria",relevant:[en.id+":1:0"]},
    ]}));
    const report=await manager.evaluateFile(file);
    expect(report).toMatchObject({cases:2,indexed:2,skipped:0,pending:0});
    expect(report.baseline.recallAt10).toBeLessThan(report.hybrid.recallAt10);
    expect(report.hybrid.recallAt10).toBe(1);
    expect(report.semanticCases).toBeGreaterThanOrEqual(1);
    expect(report.latencyMs.hybridP95).toBeGreaterThanOrEqual(0);
    expect(report.modelRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("Mitochondria use energy");
  });

  it("refuses stale revision labels instead of publishing misleading metrics",async()=>{
    const {dir,store,manager,modelPath}=fixture();
    const doc=store.importText({sourcePath:"/old.md",title:"Old",
      format:"markdown",text:"mitochondria energy"}).document;
    await manager.importFile(modelPath);await index(store,manager);
    const file=join(dir,"labels.json");
    writeFileSync(file,JSON.stringify({schema:1,cases:[
      {id:"stale",query:"energy",relevant:[doc.id+":1:0"]}]}));
    store.importText({sourcePath:"/old.md",title:"New",
      format:"markdown",text:"calculus calculus"});
    await expect(manager.evaluateFile(file)).rejects.toThrow("obsolete");
  });

  it("rejects invalid labelled results and calculates paired metrics",async()=>{
    const hit=(ordinal:number):KnowledgeSearchHit=>({
      documentId:ID,documentTitle:"Sample",documentRevision:1,ordinal,
      excerpt:"synthetic evidence",pageNumber:null,matchType:"exact"});
    const cases=[{id:"x",query:"energy",relevant:[ID+":1:0"]}];
    const metric=await evaluateLocalRetrieval(cases,{
      modelId:"test",modelRevision:"a".repeat(64),indexed:1,skipped:0,pending:0,
      assertCurrentEvidence:()=>{},
      lexical:()=>[hit(1)],
      hybrid:async()=>[hit(0)],
    });
    expect(metric.baseline.mrrAt10).toBe(0);
    expect(metric.hybrid.mrrAt10).toBe(1);
    expect(metric.hybrid.precisionAt5).toBeCloseTo(.2);
    await expect(evaluateLocalRetrieval(cases,{
      modelId:"test",modelRevision:"a".repeat(64),indexed:1,skipped:0,pending:0,
      assertCurrentEvidence:()=>{throw Error("stale citation");},
      lexical:()=>[],hybrid:async()=>[],
    })).rejects.toThrow("stale citation");
  });
});
