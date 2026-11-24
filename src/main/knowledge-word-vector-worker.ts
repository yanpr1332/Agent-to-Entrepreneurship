import {parentPort} from "node:worker_threads";
import {readStaticWordVectors,staticWordVector} from "./knowledge-word-vectors";
import {modelForStaticVectors} from "./knowledge-word-vectors";
import type {StaticWordVectors} from "./knowledge-word-vectors";

// Worker has NO HTTP clients, dynamic module imports, renderer APIs or network.
// Main supplies a previously staged private disk path and its SHA-256.
if(!parentPort)throw Error("Word-vector worker must run in a Worker thread");
const port=parentPort;
let active:StaticWordVectors|null=null;
port.on("message",(raw:unknown)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return;
  const req=raw as Record<string,unknown>;
  const id=req.id;
  if(!Number.isSafeInteger(id)||Number(id)<0)return;
  try{
    if(req.type==="init"){
      if(active||typeof req.path!=="string"||typeof req.revision!=="string")
        throw Error("Invalid offline model initialization");
      const model=readStaticWordVectors(req.path);
      if(model.revision!==req.revision)
        throw Error("Local model SHA-256 verification failed");
      active=model;
      port.postMessage({id,ok:true,model:modelForStaticVectors(model)});
      return;
    }
    if(req.type!=="embed"||!active||!Array.isArray(req.texts)||
      req.texts.length<1||req.texts.length>16||
      req.texts.some(x=>typeof x!=="string"||x.length>2200)||
      (req.kind!=="query"&&req.kind!=="passage"))
      throw Error("Invalid local inference request");
    const values=req.texts.map(x=>staticWordVector(x,active!));
    port.postMessage({id,ok:true,values});
  }catch{
    // Never send model paths, raw user passages, parsed content or stack traces
    // back across the Worker boundary.
    port.postMessage({id,ok:false,error:"LOCAL_EMBEDDING_FAILED"});
  }
});
