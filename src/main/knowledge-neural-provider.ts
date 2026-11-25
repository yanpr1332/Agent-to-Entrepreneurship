import {spawn,type ChildProcessByStdio} from "node:child_process";
import type {Readable,Writable} from "node:stream";
import {createInterface} from "node:readline";
import {join} from "node:path";
import {app} from "electron";
import {parseLocalEmbeddingModel,type LocalEmbeddingModel,
  type LocalEmbeddingProvider} from "./knowledge-embeddings";
export type NeuralKind="e5"|"bge";
const STARTUP_TIMEOUT_MS=90_000;
const INFERENCE_TIMEOUT_MS=120_000;
type WireReply={
  id?:unknown;ready?:unknown;ok?:unknown;dimension?:unknown;
  values?:unknown;error?:unknown;
};
export class OfflineNeuralPythonProvider implements LocalEmbeddingProvider {
  readonly model:LocalEmbeddingModel;
  private readonly process:ChildProcessByStdio<Writable,Readable,null>;
  private readonly pending=new Map<number,{
    resolve:(value:WireReply)=>void;reject:(reason:Error)=>void;
    timeout:ReturnType<typeof setTimeout>;
  }>();
  private seq=0;
  private closed=false;
  private readyResolve:(v:void)=>void=()=>{};
  private readyReject:(e:Error)=>void=()=>{};
  private ready=false;
  private constructor(private readonly directory:string,kind:NeuralKind,
    expected:LocalEmbeddingModel){
    this.model=parseLocalEmbeddingModel(expected);
    const python=process.env.STUDY_ANCHOR_PYTHON_PATH?.trim()||
      (process.platform==="win32"?"python":"python3");
    const script=app.isPackaged?
      join(process.resourcesPath,"neural-inference-worker.py"):
      join(process.cwd(),"scripts","neural-inference-worker.py");
    this.process=spawn(python,["-I",script,directory,kind,
      String(this.model.dimension)],{
      windowsHide:true,cwd:directory,
      stdio:["pipe","pipe","ignore"],
      env:{...process.env,HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",
        HF_HUB_DISABLE_TELEMETRY:"1",TOKENIZERS_PARALLELISM:"false",NO_PROXY:"*"},
    });
    const lines=createInterface({input:this.process.stdout,crlfDelay:Infinity});
    lines.on("line",(line)=>{
      // No stdout forwarding to logs: responses may contain private vectors.
      if(line.length>450_000){this.abort("Oversized local model response");return;}
      try{this.reply(JSON.parse(line) as WireReply);}
      catch{this.abort("Invalid local model response");}
    });
    this.process.on("error",()=>this.abort("Python offline runtime not available"));
    this.process.on("exit",()=>this.abort("Offline neural process exited"));
  }
  static async open(directory:string,kind:NeuralKind,expected:LocalEmbeddingModel):
    Promise<OfflineNeuralPythonProvider>{
    const instance=new OfflineNeuralPythonProvider(directory,kind,expected);
    try{
      await Promise.race([
        new Promise<void>((resolve,reject)=>{
          instance.readyResolve=resolve;instance.readyReject=reject;
          if(instance.closed)reject(Error("Neural worker unavailable"));
        }),
        new Promise<never>((_,reject)=>setTimeout(
          ()=>reject(Error("Neural worker initialization timed out")),
          STARTUP_TIMEOUT_MS)),
      ]);
      if(instance.closed)throw Error("Neural runtime stopped");
      return instance;
    }catch{
      instance.close();
      throw Error("Local neural ONNX runtime unavailable or model failed validation");
    }
  }
  private reply(message:WireReply):void{
    if(this.closed)return;
    if(!this.ready){
      if(message.ready===true&&message.dimension===this.model.dimension){
        this.ready=true;this.readyResolve();return;
      }
      this.readyReject(Error("Neural worker did not pass preflight"));
      this.close();return;
    }
    if(typeof message.id!=="number"||!Number.isSafeInteger(message.id))return;
    const p=this.pending.get(message.id);
    if(!p)return;
    clearTimeout(p.timeout);this.pending.delete(message.id);
    if(message.ok===true)p.resolve(message);
    else p.reject(Error("Local neural inference failed"));
  }
  private abort(message:string):void{
    if(this.closed)return;
    this.closed=true;
    if(!this.ready)this.readyReject(Error(message));
    for(const p of this.pending.values()){
      clearTimeout(p.timeout);p.reject(Error(message));
    }
    this.pending.clear();
    this.process.kill();
  }
  private async infer(texts:readonly string[],kind:"passage"|"query"):
    Promise<readonly (readonly number[])[]>{
    if(this.closed||!this.ready)throw Error("Neural runtime is not ready");
    if(!Array.isArray(texts)||texts.length<1||texts.length>16||
      texts.some(t=>typeof t!=="string"||!t.length||t.length>2200))
      throw Error("Invalid neural inference batch");
    if(this.pending.size>=2)throw Error("Neural inference queue full");
    const id=++this.seq;
    const promise=new Promise<WireReply>((resolve,reject)=>{
      const timeout=setTimeout(()=>this.abort("Neural inference timed out"),
        INFERENCE_TIMEOUT_MS);
      this.pending.set(id,{resolve,reject,timeout});
    });
    try{
      this.process.stdin.write(JSON.stringify({id,kind,texts})+"\n");
    }catch{
      this.abort("Cannot send offline neural inference request");
    }
    const reply=await promise;
    if(!Array.isArray(reply.values)||reply.values.length!==texts.length)
      throw Error("Neural inference response count mismatch");
    const vectors=reply.values as unknown[];
    for(const vector of vectors){
      if(!Array.isArray(vector)||vector.length!==this.model.dimension||
        vector.some(v=>typeof v!=="number"||!Number.isFinite(v)))
        throw Error("Invalid neural embedding vector");
    }
    return vectors as number[][];
  }
  embed(texts:readonly string[],kind:"passage"|"query"){
    return this.infer(texts,kind);
  }
  close():void{this.abort("Neural worker closed");}
}
