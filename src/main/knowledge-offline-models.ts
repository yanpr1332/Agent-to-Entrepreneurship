import {createHash,randomUUID} from "node:crypto";
import {
  closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,
  readFileSync,renameSync,rmSync,writeFileSync,
} from "node:fs";
import {join} from "node:path";
import {KnowledgeStore} from "./knowledge-store";
import {OfflineWordVectorWorker} from "./knowledge-word-vector-provider";
import {OfflineNeuralPythonProvider,type NeuralKind} from "./knowledge-neural-provider";
import {stageNeuralAssets,verifyNeuralRecord,type NeuralInstallRecord}
  from "./knowledge-neural-assets";
import {
  MAX_LOCAL_VECTOR_FILE,modelForStaticVectors,loadStaticWordVectors,
} from "./knowledge-word-vectors";
import {parseLocalEmbeddingModel,sameEmbeddingModel,type LocalEmbeddingModel,
  type LocalEmbeddingProvider} from "./knowledge-embeddings";
import type {KnowledgeSearchHit,KnowledgeEmbeddingStatus,
  KnowledgeEvaluationReport} from "../shared/knowledge-model";
import {readLocalEvaluationLabels,evaluateLocalRetrieval} from "./knowledge-quality-audit";

type Handle=LocalEmbeddingProvider & {close():void};
export type WordVectorFactory=(path:string,model:LocalEmbeddingModel)=>Promise<Handle>;
interface StaticInstallRecord {schema:1;file:string;model:LocalEmbeddingModel;}
type InstallRecord=StaticInstallRecord|NeuralInstallRecord;
export type NeuralFactory=(path:string,kind:NeuralKind,model:LocalEmbeddingModel)=>
  Promise<Handle>;
export interface LocalModelStatus extends KnowledgeEmbeddingStatus {
  installed:boolean;
  running:boolean;
  engine:"static-word-vectors"|"onnx-e5"|"onnx-bge"|null;
  error:string|null;
}
/** Version-pinned LOCAL assets. Does not fetch URLs or run model inference in
 * the renderer. Only Main's native file picker supplies a source file. */
export class KnowledgeOfflineModels {
  private provider:Handle|null=null;
  private record:InstallRecord|null=null;
  private generation=0;
  private running=false;
  private error:string|null=null;
  private readonly directory:string;
  private readonly manifest:string;
  constructor(
    userData:string,private readonly store:KnowledgeStore,
    private readonly factory:WordVectorFactory=(path,model)=>
      OfflineWordVectorWorker.open(path,model),
    private readonly neuralFactory:NeuralFactory=(path,kind,model)=>
      OfflineNeuralPythonProvider.open(path,kind,model),
  ){
    this.directory=join(userData,"knowledge-models");
    this.manifest=join(this.directory,"installed.json");
  }
  private ensureDirectory():void{
    if(existsSync(this.directory)){
      const info=lstatSync(this.directory);
      if(!info.isDirectory()||info.isSymbolicLink())
        throw Error("Unsafe local embedding model directory");
    }else mkdirSync(this.directory,{recursive:true,mode:0o700});
  }
  private fileFor(model:LocalEmbeddingModel):string{
    const item=parseLocalEmbeddingModel(model);
    return join(this.directory,item.revision+".vec");
  }
  status():LocalModelStatus{
    return {...this.store.embeddingStatus(),installed:this.provider!==null,
      running:this.running,engine:this.provider?(this.record?.schema===2?
        this.record.kind==="e5"?"onnx-e5":"onnx-bge":"static-word-vectors"):null,
      error:this.error};
  }
  private removeAsset(record:InstallRecord):void{
    const path=join(this.directory,record.file);
    if(!existsSync(path))return;
    const info=lstatSync(path);
    if(info.isSymbolicLink())throw Error("Unsafe stored model asset");
    if(record.schema===2&&info.isDirectory())rmSync(path,{recursive:true,force:true});
    if(record.schema===1&&info.isFile())rmSync(path,{force:true});
  }
  /** Startup failures do NOT make the personal knowledge database unavailable.
   * Inconsistent/corrupt assets remain untouched for review; lexical search
   * continues until the user removes or reimports a verified model. */
  async restore():Promise<void>{
    if(!existsSync(this.manifest))return;
    try{
      this.ensureDirectory();
      const info=lstatSync(this.manifest);
      if(!info.isFile()||info.isSymbolicLink()||info.size>4096)
        throw Error("Invalid installed model manifest");
      const raw=JSON.parse(readFileSync(this.manifest,"utf8")) as InstallRecord;
      if(raw.schema!==1&&raw.schema!==2)
        throw Error("Unknown installed model manifest");
      let record:InstallRecord,worker:Handle;
      if(raw.schema===1){
        if(typeof raw.file!=="string")throw Error("Invalid installed model manifest");
        const model=parseLocalEmbeddingModel(raw.model);
        if(raw.file!==model.revision+".vec")
          throw Error("Installed model filename does not match digest");
        worker=await this.factory(this.fileFor(model),model);
        record={schema:1,file:raw.file,model};
      }else{
        if(typeof raw.file!=="string"||!/^neural-[a-f0-9]{64}$/.test(raw.file))
          throw Error("Invalid neural model folder");
        record=verifyNeuralRecord(join(this.directory,raw.file),raw);
        worker=await this.neuralFactory(
          join(this.directory,record.file),record.kind,record.model);
      }
      this.provider=worker;
      this.record=record;
      const model=record.model;
      if(!this.store.embeddingModel()||
        !sameEmbeddingModel(this.store.embeddingModel()!,model))
        this.store.configureLocalEmbeddingModel(model);
      this.error=null;
    }catch{
      this.provider?.close();this.provider=null;this.record=null;
      this.error="本机模型文件或校验信息不可用；已安全退回精确/容错搜索。";
    }
  }
  /** Model source path comes ONLY from Electron's trusted native picker.
   * The caller must collect explicit user acknowledgement of third-party
   * source/license before calling this function. No remote downloads. */
  async importFile(sourcePath:string):Promise<LocalModelStatus>{
    if(this.running)throw Error("Cancel local indexing before changing model");
    this.ensureDirectory();
    if(typeof sourcePath!=="string"||!sourcePath.toLowerCase().endsWith(".vec"))
      throw Error("Choose a local UTF-8 .vec word-vector file");
    const pathInfo=lstatSync(sourcePath);
    if(!pathInfo.isFile()||pathInfo.isSymbolicLink()||
      pathInfo.size<10||pathInfo.size>MAX_LOCAL_VECTOR_FILE)
      throw Error("Unsupported or oversized local word-vector file");
    const fd=openSync(sourcePath,constants.O_RDONLY|
      (process.platform==="win32"?0:constants.O_NOFOLLOW));
    let bytes:Buffer;
    try{
      const opened=fstatSync(fd);
      if(!opened.isFile()||opened.size>MAX_LOCAL_VECTOR_FILE)
        throw Error("Invalid local word-vector input");
      bytes=readFileSync(fd);
    }finally{closeSync(fd);}
    // The model is a genuine (possibly limited) static word embedding; no
    // synthetic vectors, hosted inference, scripts or arbitrary executables.
    const verified=loadStaticWordVectors(bytes);
    const model=modelForStaticVectors(verified);
    const path=this.fileFor(model),prior=this.record;
    let temp:string|null=null;
    let installedNew=false;
    let next:Handle|null=null;
    try{
      if(existsSync(path)){
        const existing=lstatSync(path);
        if(!existing.isFile()||existing.isSymbolicLink()||
          createHash("sha256").update(readFileSync(path)).digest("hex")!==model.revision)
          throw Error("Installed local model checksum mismatch");
      }else{
        temp=join(this.directory,".import-"+randomUUID());
        writeFileSync(temp,bytes,{flag:"wx",mode:0o600});
        renameSync(temp,path);temp=null;installedNew=true;
      }
      next=await this.factory(path,model);
      const record:StaticInstallRecord={schema:1,file:model.revision+".vec",model};
      const tmpManifest=join(this.directory,".manifest-"+randomUUID());
      temp=tmpManifest;
      writeFileSync(tmpManifest,JSON.stringify(record),{flag:"wx",mode:0o600});
      // Index is invalidated atomically inside the existing local database.
      this.store.configureLocalEmbeddingModel(model);
      renameSync(tmpManifest,this.manifest);temp=null;
      this.generation++;
      const old=this.provider;
      this.provider=next;this.record=record;this.error=null;next=null;
      old?.close();
      if(prior&&prior.file!==record.file)this.removeAsset(prior);
      return this.status();
    }catch{
      next?.close();
      if(installedNew)rmSync(path,{force:true});
      throw Error("Offline word-vector installation was not completed");
    }finally{if(temp)rmSync(temp,{force:true});}
  }
  /** Install a vetted E5/BGE ONNX directory chosen by a native picker.
   * No dependency download, scripts, or model paths from Renderer. */
  async importNeuralDirectory(source:string,kind:NeuralKind):Promise<LocalModelStatus>{
    if(this.running)throw Error("Cancel indexing before changing model");
    this.ensureDirectory();
    const staged=stageNeuralAssets(source,this.directory,kind);
    const record=staged.record;
    const dest=join(this.directory,record.file);
    const prior=this.record;
    let added=false,next:Handle|null=null,temp:string|null=null;
    try{
      if(existsSync(dest)){
        verifyNeuralRecord(dest,record);
        rmSync(staged.path,{recursive:true,force:true});
      }else{
        renameSync(staged.path,dest);added=true;
      }
      next=await this.neuralFactory(dest,kind,record.model);
      temp=join(this.directory,".manifest-"+randomUUID());
      writeFileSync(temp,JSON.stringify(record),{flag:"wx",mode:0o600});
      this.store.configureLocalEmbeddingModel(record.model);
      renameSync(temp,this.manifest);temp=null;
      this.generation++;
      const old=this.provider;
      this.provider=next;this.record=record;this.error=null;next=null;
      old?.close();
      if(prior&&prior.file!==record.file)this.removeAsset(prior);
      return this.status();
    }catch{
      next?.close();
      if(added)rmSync(dest,{recursive:true,force:true});
      throw Error("Neural ONNX installation failed (assets or offline runtime)");
    }finally{
      if(temp)rmSync(temp,{force:true});
      if(existsSync(staged.path))rmSync(staged.path,{recursive:true,force:true});
    }
  }
  async search(query:unknown):Promise<KnowledgeSearchHit[]>{
    if(!this.provider)return this.store.search(query);
    try{return await this.store.searchWithEmbeddings(query,this.provider);}
    catch{
      this.error="本机模型推理失败，已退回词法检索；请核查离线运行环境。";
      return this.store.search(query);
    }
  }
  /** Local-only paired relevance evaluation. Main passes a path from its
   * native file picker; no case text, labels or results are transmitted. */
  async evaluateFile(path:string):Promise<KnowledgeEvaluationReport>{
    const provider=this.provider,record=this.record;
    if(!provider||!record||this.running)
      throw Error("Install and finish indexing the local model before evaluation");
    const labels=readLocalEvaluationLabels(path);
    const status=this.store.embeddingStatus();
    if(!status.model||status.indexed===0)
      throw Error("Local evaluation requires indexed model passages");
    const epoch=this.generation;
    const assertCurrent=()=>{
      if(epoch!==this.generation||!this.provider||!this.record)
        throw Error("Local model changed while running evaluation");
    };
    const report=await evaluateLocalRetrieval(labels,{
      modelId:record.model.id,modelRevision:record.model.revision,
      indexed:status.indexed,skipped:status.skipped,pending:status.pending,
      assertCurrentEvidence:(key)=>{
        const [id,revision,ordinal]=key.split(":");
        const source=this.store.getPassage(id,Number(ordinal));
        if(source.revision!==Number(revision))
          throw Error("Local evaluation labels reference an obsolete source revision");
      },
      lexical:(query)=>{assertCurrent();return this.store.search(query);},
      hybrid:async(query)=>{assertCurrent();
        const result=await this.store.searchWithEmbeddings(query,provider);
        assertCurrent();return result;
      },
    });
    assertCurrent();
    return report;
  }

  startIndex():LocalModelStatus{
    if(!this.provider)throw Error("Install a verified local embedding model first");
    if(this.running)throw Error("Local knowledge indexing is already running");
    const epoch=++this.generation,provider=this.provider;
    this.running=true;this.error=null;
    void (async()=>{
      try{
        for(;;){
          if(epoch!==this.generation)break;
          const next=this.store.nextEmbeddingTarget();
          if(!next)break;
          await this.store.indexEmbeddingBatch(provider,next.documentId,next.revision,
            next.ordinal,()=>epoch!==this.generation);
          await new Promise<void>(resolve=>setImmediate(resolve));
        }
      }catch{
        if(epoch===this.generation)
          this.error="部分资料无法离线编码或索引已变化；已保留已完成的本机批次，可重试。";
      }finally{
        if(epoch===this.generation)this.running=false;
      }
    })();
    return this.status();
  }
  cancel():LocalModelStatus{
    if(this.running){this.generation++;this.running=false;}
    return this.status();
  }
  remove():LocalModelStatus{
    this.generation++;this.running=false;
    const old=this.record;this.record=null;
    this.provider?.close();this.provider=null;
    this.store.clearLocalEmbeddings();
    if(old){
      rmSync(this.manifest,{force:true});
      this.removeAsset(old);
    }else if(existsSync(this.manifest)){
      rmSync(this.manifest,{force:true});
    }
    this.error=null;
    return this.status();
  }
  close():void{
    this.generation++;this.running=false;this.provider?.close();
    this.provider=null;
  }
}
