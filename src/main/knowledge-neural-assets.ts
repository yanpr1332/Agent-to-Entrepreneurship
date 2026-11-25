import {createHash,randomUUID} from "node:crypto";
import {
  closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,
  openSync,readFileSync,readSync,renameSync,rmSync,writeSync,writeFileSync,
} from "node:fs";
import {join} from "node:path";
import {parseLocalEmbeddingModel,type LocalEmbeddingModel}
  from "./knowledge-embeddings";
import type {NeuralKind} from "./knowledge-neural-provider";

const MAX_GRAPH=750*1024*1024;
const MAX_TOKENIZER=24*1024*1024;
const MAX_CONFIG=64*1024;
const MAX_TOTAL=800*1024*1024;
const MODEL_NAMES:Record<NeuralKind,string>={
  e5:"intfloat/multilingual-e5-small",
  bge:"baai/bge-small-zh-v1.5",
};
const DIMENSIONS:Record<NeuralKind,number>={e5:384,bge:512};
const ALLOWED=new Set(["model.onnx","config.json","tokenizer.json",
  "vocab.txt","tokenizer_config.json","special_tokens_map.json"]);
export interface NeuralInstallRecord {
  schema:2;file:string;kind:NeuralKind;
  assets:Record<string,string>;
  model:LocalEmbeddingModel;
}
function safeDir(path:string):void{
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw Error("Neural model directory must be a real local directory");
}
function allowedFile(name:string):number{
  if(!ALLOWED.has(name))throw Error("Unapproved ONNX model asset");
  return name==="model.onnx"?MAX_GRAPH:
    name==="tokenizer.json"||name==="vocab.txt"?MAX_TOKENIZER:MAX_CONFIG;
}
/** Return a SHA-256 of exact bytes read through O_NOFOLLOW file handle.
 * A swapped symlink or a changed file fails prior to installation. */
function readHash(path:string,name:string,destination?:string):string{
  const sizeLimit=allowedFile(name);
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>sizeLimit)
    throw Error("Invalid or oversized local ONNX model asset");
  const input=openSync(path,constants.O_RDONLY|
    (process.platform==="win32"?0:constants.O_NOFOLLOW));
  let target:number|null=null;
  try{
    if(destination!==undefined)
      target=openSync(destination,
        constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    const opened=fstatSync(input);
    if(!opened.isFile()||opened.size!==stat.size||opened.size>sizeLimit)
      throw Error("ONNX asset changed during verification");
    const buffer=Buffer.allocUnsafe(512*1024);
    let total=0;
    const sha=createHash("sha256");
    for(;;){
      const n=readSync(input,buffer,0,buffer.length,null);
      if(n===0)break;
      total+=n;
      if(total>sizeLimit)throw Error("ONNX asset exceeded approved size");
      sha.update(buffer.subarray(0,n));
      if(target!==null){
        let offset=0;
        while(offset<n){
          const written=writeSync(target,buffer,offset,n-offset);
          if(written<=0)throw Error("Cannot copy ONNX asset");
          offset+=written;
        }
      }
    }
    if(total!==opened.size)throw Error("ONNX asset length changed while reading");
    const latest=fstatSync(input);
    if(latest.size!==opened.size||latest.mtimeMs!==opened.mtimeMs)
      throw Error("ONNX asset changed while reading");
    return sha.digest("hex");
  }finally{
    closeSync(input);
    if(target!==null)closeSync(target);
  }
}
export function deriveNeuralModel(kind:NeuralKind,
  hashes:Record<string,string>):LocalEmbeddingModel{
  const entries=Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.some(([n])=>n==="model.onnx")||
    !entries.some(([n])=>n==="config.json")||
    !entries.some(([n])=>n==="tokenizer.json"||n==="vocab.txt")||
    entries.some(([n,v])=>!ALLOWED.has(n)||!/^[a-f0-9]{64}$/.test(v)))
    throw Error("Incomplete neural ONNX assets");
  const digest=createHash("sha256").update(
    JSON.stringify({schema:2,kind,assets:entries,
      pooling:kind==="e5"?"attention-mean":"cls",maxTokens:512}),
    "utf8").digest("hex");
  return {id:MODEL_NAMES[kind],revision:digest,
    dimension:DIMENSIONS[kind],format:"float32-l2",
    protocol:"passage-query-v1"};
}
function validateConfig(dir:string,kind:NeuralKind):void{
  const config=JSON.parse(readFileSync(join(dir,"config.json"),"utf8")) as
    Record<string,unknown>;
  if(config.model_type!=="bert"||config.hidden_size!==DIMENSIONS[kind])
    throw Error("Selected ONNX config does not match the approved model family");
}
function assetList(source:string):Array<{name:string;from:string}>{
  safeDir(source);
  const graph=existsSync(join(source,"model.onnx"))?
    join(source,"model.onnx"):join(source,"onnx","model_quantized.onnx");
  if(graph!==join(source,"model.onnx"))safeDir(join(source,"onnx"));
  const selected=[{name:"model.onnx",from:graph}];
  for(const name of ["config.json","tokenizer.json","vocab.txt",
    "tokenizer_config.json","special_tokens_map.json"]){
    if(existsSync(join(source,name)))selected.push({name,from:join(source,name)});
  }
  return selected;
}
/** Stages only a fixed set of data files (no scripts, links or executables).
 * The caller owns the resulting folder and must remove it on failure. */
export function stageNeuralAssets(source:string,userModelDir:string,kind:NeuralKind):
  {path:string;record:NeuralInstallRecord}{
  if(kind!=="e5"&&kind!=="bge")throw Error("Unsupported local neural model");
  safeDir(source);safeDir(userModelDir);
  const staging=join(userModelDir,".neural-stage-"+randomUUID());
  mkdirSync(staging,{mode:0o700});
  try{
    const hashes:Record<string,string>={};
    let total=0;
    for(const item of assetList(source)){
      hashes[item.name]=readHash(item.from,item.name,join(staging,item.name));
      total+=lstatSync(join(staging,item.name)).size;
      if(total>MAX_TOTAL)throw Error("ONNX assets exceed 800 MiB");
    }
    validateConfig(staging,kind);
    const model=deriveNeuralModel(kind,hashes);
    return {path:staging,record:{schema:2,
      file:"neural-"+model.revision,kind,assets:hashes,model}};
  }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
}
/** Re-read assets on every startup; corrupted/changed weights must not
 * silently share indexed vectors from a previously trusted revision. */
export function verifyNeuralRecord(dir:string,raw:unknown):NeuralInstallRecord{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("Invalid neural model installation record");
  const r=raw as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!=="assets,file,kind,model,schema"||
    r.schema!==2||(r.kind!=="e5"&&r.kind!=="bge")||
    !r.assets||typeof r.assets!=="object"||Array.isArray(r.assets))
    throw Error("Invalid neural model record");
  const hashes=r.assets as Record<string,unknown>;
  const names=Object.keys(hashes);
  if(names.length<3||names.length>6||names.some(name=>!ALLOWED.has(name)||
    typeof hashes[name]!=="string"||!/^[a-f0-9]{64}$/.test(hashes[name] as string)))
    throw Error("Invalid neural model asset checksums");
  const expected=deriveNeuralModel(r.kind,hashes as Record<string,string>);
  const model=parseLocalEmbeddingModel(r.model);
  if(JSON.stringify(model)!==JSON.stringify(expected)||
    r.file!=="neural-"+model.revision)
    throw Error("Neural model identity differs from installed assets");
  safeDir(dir);
  for(const name of names){
    if(readHash(join(dir,name),name)!==hashes[name])
      throw Error("Neural model checksum mismatch");
  }
  validateConfig(dir,r.kind);
  return {schema:2,file:r.file,kind:r.kind,
    assets:hashes as Record<string,string>,model};
}
