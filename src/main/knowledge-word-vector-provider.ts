import {Worker} from "node:worker_threads";
import {join} from "node:path";
import {
  parseLocalEmbeddingModel,sameEmbeddingModel,type LocalEmbeddingModel,
  type LocalEmbeddingProvider,
} from "./knowledge-embeddings";

type Request={id:number;type:"init";path:string;revision:string}|
  {id:number;type:"embed";kind:"query"|"passage";texts:readonly string[]};
type Reply={id:number;ok:boolean;model?:unknown;values?:unknown;error?:string};
const INIT_TIMEOUT=20_000;
const EMBED_TIMEOUT=15_000;

/** Owns a single isolated worker. No URL accepted; file path is only from
 * Main's locally installed, hash-validated model manifest. */
export class OfflineWordVectorWorker implements LocalEmbeddingProvider {
  readonly model:LocalEmbeddingModel;
  private readonly worker:Worker;
  private pending=new Map<number,{resolve:(v:Reply)=>void;reject:(e:Error)=>void;
    timeout:ReturnType<typeof setTimeout>}>();
  private sequence=0;
  private closed=false;
  private constructor(model:LocalEmbeddingModel){
    this.model=parseLocalEmbeddingModel(model);
    this.worker=new Worker(join(__dirname,"knowledge-word-vector-worker.js"));
    this.worker.on("message",(message:Reply)=>this.reply(message));
    this.worker.on("error",()=>this.abort("Offline embedding worker failed"));
    this.worker.on("exit",()=>this.abort("Offline embedding worker stopped"));
  }
  static async open(path:string,expected:LocalEmbeddingModel):
    Promise<OfflineWordVectorWorker>{
    const instance=new OfflineWordVectorWorker(expected);
    try{
      const result=await instance.request({type:"init",path,
        revision:expected.revision},INIT_TIMEOUT);
      const model=parseLocalEmbeddingModel(result.model);
      if(!sameEmbeddingModel(model,expected))
        throw Error("Offline model identity mismatch");
      return instance;
    }catch{
      instance.close();
      throw Error("Offline model file failed verification or local worker startup");
    }
  }
  private reply(raw:Reply):void{
    if(!raw||!Number.isSafeInteger(raw.id))return;
    const item=this.pending.get(raw.id);
    if(!item)return;
    this.pending.delete(raw.id);
    clearTimeout(item.timeout);
    if(raw.ok)item.resolve(raw);
    else item.reject(Error("Offline embedding inference failed"));
  }
  private abort(reason:string):void{
    if(this.closed)return;
    this.closed=true;
    for(const item of this.pending.values()){
      clearTimeout(item.timeout);item.reject(Error(reason));
    }
    this.pending.clear();
    void this.worker.terminate();
  }
  private request(req:Omit<Request,"id">,timeoutMs:number):Promise<Reply>{
    if(this.closed)return Promise.reject(Error("Offline embedding worker is closed"));
    const id=++this.sequence;
    if(this.pending.size>2)
      return Promise.reject(Error("Offline embedding queue is full"));
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>this.abort("Offline embedding operation timed out"),timeoutMs);
      this.pending.set(id,{resolve,reject,timeout});
      this.worker.postMessage({...req,id});
    });
  }
  async embed(texts:readonly string[],kind:"passage"|"query"):
    Promise<readonly (readonly number[])[]>{
    if(!Array.isArray(texts)||texts.length<1||texts.length>16||
      texts.some(x=>typeof x!=="string"||x.length<1||x.length>2200))
      throw Error("Invalid offline embedding batch");
    const reply=await this.request({type:"embed",texts,kind},EMBED_TIMEOUT);
    if(!Array.isArray(reply.values)||reply.values.length!==texts.length)
      throw Error("Offline model returned invalid embedding count");
    return reply.values as number[][];
  }
  close():void{this.abort("Offline embedding worker closed");}
}
