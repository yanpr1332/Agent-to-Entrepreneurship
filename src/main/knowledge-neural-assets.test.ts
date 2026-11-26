import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,
  symlinkSync,appendFileSync} from "node:fs";
import {join} from "node:path";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {KnowledgeStore} from "./knowledge-store";
import {KnowledgeOfflineModels,type NeuralFactory} from "./knowledge-offline-models";
import {deriveNeuralModel,stageNeuralAssets,verifyNeuralRecord}
  from "./knowledge-neural-assets";
import type {NeuralKind} from "./knowledge-neural-provider";
import type {LocalEmbeddingModel,LocalEmbeddingProvider} from "./knowledge-embeddings";
const folders:string[]=[];
const databases:KnowledgeStore[]=[];
const managers:KnowledgeOfflineModels[]=[];
const makeRoot=()=>{
  const dir=mkdtempSync(join(tmpdir(),"sa-neural-test-"));folders.push(dir);return dir;
};
function source(root:string,kind:NeuralKind,tokenizer="tokenizer.json"){
  const dir=join(root,kind+"-source-"+tokenizer);
  mkdirSync(dir);
  writeFileSync(join(dir,"model.onnx"),Buffer.from("genuine-model-replaced-by-synthetic-test-fixture"));
  writeFileSync(join(dir,"config.json"),JSON.stringify({model_type:"bert",
    hidden_size:kind==="e5"?384:512}));
  writeFileSync(join(dir,tokenizer),tokenizer==="vocab.txt"?"test\nhello\n":"{}");
  writeFileSync(join(dir,"tokenizer_config.json"),"{}");
  return dir;
}
type Handle=LocalEmbeddingProvider&{close:()=>void};
const fakeNeural:NeuralFactory=async(directory,kind,model)=>{
  const real=verifyNeuralRecord(directory,{
    schema:2,file:"neural-"+model.revision,kind,
    assets:Object.fromEntries(["model.onnx","config.json",
      "tokenizer.json","vocab.txt","tokenizer_config.json"].filter(n=>
        existsSync(join(directory,n))).map(n=>[
        n,
        // Fixture-only independent test hash. Real installer supplies SHA.
        requireHash(readFileSync(join(directory,n))),
      ])),model,
  });
  if(real.kind!==kind)throw Error("Wrong engine");
  const vector=(text:string)=>Array.from({length:model.dimension},(_,i)=>
    i===0?1:i===1?Math.min(1,text.length/100):0);
  return {model,embed:async(texts)=>texts.map(vector),close(){}};
};
function requireHash(bytes:Buffer){
  return createHash("sha256").update(bytes).digest("hex");
}
import {createHash} from "node:crypto";
function manager(root:string,factory:NeuralFactory=fakeNeural){
  const store=new KnowledgeStore(join(root,"knowledge.sqlite"));databases.push(store);
  const service=new KnowledgeOfflineModels(root,store,
    async()=>{throw Error("Static backend not expected");},factory);
  managers.push(service);return {store,service};
}
afterEach(()=>{
  while(managers.length)managers.pop()!.close();
  while(databases.length)databases.pop()!.close();
  while(folders.length)rmSync(folders.pop()!,{recursive:true,force:true});
});
async function finish(service:KnowledgeOfflineModels){
  for(let n=0;n<100;n++){
    if(!service.status().running)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error("Timed out waiting for indexing in test");
}
describe("KB-005D local E5/BGE asset supply chain and index integration",()=>{
  it("stages SHA-pinned neural assets without executing untrusted model code",()=>{
    const root=makeRoot();
    const models=join(root,"knowledge-models");mkdirSync(models);
    const dir=source(root,"e5");
    const staged=stageNeuralAssets(dir,models,"e5");
    expect(staged.record.model).toMatchObject({
      id:"intfloat/multilingual-e5-small",dimension:384,
      format:"float32-l2",protocol:"passage-query-v1",
    });
    expect(verifyNeuralRecord(staged.path,staged.record)).toEqual(staged.record);
    expect(staged.record.model.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>verifyNeuralRecord(staged.path,{
      ...staged.record,file:"../outside",
    })).toThrow();
    appendFileSync(join(staged.path,"model.onnx"),"changed-after-install");
    expect(()=>verifyNeuralRecord(staged.path,staged.record)).toThrow();
  });
  it("supports validated BGE CLS model family and alternative vocabulary file",()=>{
    const root=makeRoot();const models=join(root,"knowledge-models");
    mkdirSync(models);
    const staged=stageNeuralAssets(source(root,"bge","vocab.txt"),models,"bge");
    expect(staged.record.model).toMatchObject({
      id:"baai/bge-small-zh-v1.5",dimension:512,
    });
    expect(verifyNeuralRecord(staged.path,staged.record)).toEqual(staged.record);
    expect(()=>deriveNeuralModel("bge",{...staged.record.assets,
      evil:"a".repeat(64)})).toThrow("Incomplete");
  });
  it("imports official-style onnx/model.onnx without copying arbitrary sibling scripts",()=>{
    const root=makeRoot(),models=join(root,"knowledge-models");
    mkdirSync(models);
    const dir=source(root,"e5");
    rmSync(join(dir,"model.onnx"));
    mkdirSync(join(dir,"onnx"));
    writeFileSync(join(dir,"onnx","model.onnx"),
      "offline fixture graph from fixed official-style nested layout");
    writeFileSync(join(dir,"onnx","bad-remote-code.py"),"raise RuntimeError('never execute')");
    const staged=stageNeuralAssets(dir,models,"e5");
    expect(staged.record.model.dimension).toBe(384);
    expect(existsSync(join(staged.path,"model.onnx"))).toBe(true);
    expect(existsSync(join(staged.path,"bad-remote-code.py"))).toBe(false);
    expect(verifyNeuralRecord(staged.path,staged.record)).toEqual(staged.record);
  });

  it("rejects symlinked, wrong-dimension and missing graph model inputs",()=>{
    const root=makeRoot();const models=join(root,"knowledge-models");
    mkdirSync(models);
    const dir=source(root,"e5");
    if(process.platform!=="win32"){
      rmSync(join(dir,"model.onnx"));
      symlinkSync("/etc/passwd",join(dir,"model.onnx"));
      expect(()=>stageNeuralAssets(dir,models,"e5")).toThrow();
      rmSync(join(dir,"model.onnx"));
      writeFileSync(join(dir,"model.onnx"),"a pretend graph");
    }
    writeFileSync(join(dir,"config.json"),JSON.stringify({
      model_type:"bert",hidden_size:512,
    }));
    expect(()=>stageNeuralAssets(dir,models,"e5")).toThrow("config");
    expect(existsSync(join(models,"installed.json"))).toBe(false);
  });
  it("imports offline neural model, reuses revision-pinned index and restores",async()=>{
    const root=makeRoot(),{store,service}=manager(root);
    const dir=source(root,"e5");
    store.importText({sourcePath:"/test.md",title:"Test",
      format:"markdown",text:"Mitochondria produce ATP energy."});
    const status=await service.importNeuralDirectory(dir,"e5");
    expect(status).toMatchObject({installed:true,engine:"onnx-e5",
      indexed:0,total:1});
    service.startIndex();await finish(service);
    expect(service.status()).toMatchObject({indexed:1,pending:0,error:null});
    expect((await service.search("mitochondria")).length).toBeGreaterThan(0);
    const revision=service.status().model?.revision;
    service.close();
    const restored=new KnowledgeOfflineModels(root,store,
      async()=>{throw Error("Unexpected static");},fakeNeural);
    managers.push(restored);await restored.restore();
    expect(restored.status()).toMatchObject({engine:"onnx-e5",
      installed:true,indexed:1});
    expect(restored.status().model?.revision).toBe(revision);
    expect(restored.remove()).toMatchObject({installed:false,indexed:0,model:null});
    expect(store.listDocuments()).toHaveLength(1);
  });
  it("does not overwrite a working model when the runtime cannot start",async()=>{
    const root=makeRoot(),{service}=manager(root);
    const dir=source(root,"e5");
    await service.importNeuralDirectory(dir,"e5");
    const original=service.status().model?.revision;
    const bge=source(root,"bge");
    const alternate=new KnowledgeStore(join(root,"alternate.sqlite"));
    databases.push(alternate);
    const failing=new KnowledgeOfflineModels(root,alternate,
      async()=>{throw Error("No static");},
      async()=>{throw Error("Python unavailable");});
    managers.push(failing);
    await expect(failing.importNeuralDirectory(bge,"bge"))
      .rejects.toThrow("runtime");
    expect(service.status().model?.revision).toBe(original);
    expect(JSON.parse(readFileSync(join(root,"knowledge-models","installed.json"),
      "utf8")).model.revision).toBe(original);
  });
  it("keeps newly committed neural model if old-asset cleanup fails",async()=>{
    const root=makeRoot(),{service}=manager(root);
    await service.importNeuralDirectory(source(root,"e5"),"e5");
    const delegate=service as unknown as {removeAsset:(record:unknown)=>void};
    const original=delegate.removeAsset;
    delegate.removeAsset=()=>{throw Error("EPERM: old model is busy");};
    try{
      const result=await service.importNeuralDirectory(source(root,"bge"),"bge");
      expect(result.engine).toBe("onnx-bge");
      expect(result.installed).toBe(true);
      expect(result.error).toContain("清理失败");
      expect(JSON.parse(readFileSync(join(root,"knowledge-models","installed.json"),
        "utf8")).model.id).toBe("baai/bge-small-zh-v1.5");
    }finally{delegate.removeAsset=original;}
  });

  it("rejects model tampering at startup and retains lexical fallback",async()=>{
    const root=makeRoot(),{store,service}=manager(root);
    const dir=source(root,"bge");
    const installed=await service.importNeuralDirectory(dir,"bge");
    service.close();
    writeFileSync(join(root,"knowledge-models",
      "neural-"+installed.model!.revision,"model.onnx"),"tampered graph");
    const restored=new KnowledgeOfflineModels(root,store,
      async()=>{throw Error("Static");},fakeNeural);
    managers.push(restored);
    await restored.restore();
    expect(restored.status()).toMatchObject({installed:false,engine:null});
    expect(restored.status().error).toContain("模型文件");
    expect(await restored.search("ATP")).toEqual(store.search("ATP"));
  });
});
