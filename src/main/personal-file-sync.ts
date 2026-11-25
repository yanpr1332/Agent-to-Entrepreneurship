import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {basename,join} from "node:path";
import {existsSync,lstatSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {requireUuid} from "../shared/cloud-model";
import {
  MAX_SYNC_FILE_BYTES,MAX_SYNC_FILE_COUNT,
  requireFileHash,requireFileSize,requireFileVersion,requirePersonalFileName,
  type StagedPersonalFile,type PersonalFilesOverview,
} from "../shared/personal-file-sync";
import type {SharedCloudClient} from "./cloud/supabase-client";

type FileCloud=Pick<SharedCloudClient,
  "currentUserId"|"listPersonalFiles"|"readPersonalFile"|"applyPersonalFile"|"deletePersonalFile">;
type PendingRow={
  owner_id:string;file_id:string;filename:string;sha256:string;
  byte_length:number;base_version:number;
};
const sha=(data:Buffer)=>createHash("sha256").update(data).digest("hex");

/**
 * Only files picked by a native Electron dialog are staged. The original path
 * never crosses IPC, and there is no folder scanning, background upload,
 * Canvas/mail/knowledge auto-import, or remote filesystem path syncing.
 */
export class PersonalFileSyncService {
  private readonly db:DatabaseSync;
  private readonly stageRoot:string;
  private readonly downloadRoot:string;
  private inFlight=false;
  constructor(private readonly cloud:FileCloud, private readonly userData:string){
    this.stageRoot=join(userData,"study-anchor-file-staging");
    this.downloadRoot=join(userData,"study-anchor-cloud-downloads");
    this.db=new DatabaseSync(join(userData,"study-anchor-file-sync.sqlite"));
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL");
    const v=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(v>1)throw Error("Personal file sync database requires a newer app");
    if(v===0){
      this.db.exec("CREATE TABLE file_pending("+
        "owner_id TEXT NOT NULL,file_id TEXT NOT NULL,filename TEXT NOT NULL,"+
        "sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,"+
        "base_version INTEGER NOT NULL,created_at TEXT NOT NULL,"+
        "PRIMARY KEY(owner_id,file_id),"+
        "CHECK(byte_length BETWEEN 1 AND 1048576),CHECK(base_version>=0));"+
        "PRAGMA user_version=1;");
    }
  }
  close():void{this.db.close();}
  private owner():string{return requireUuid(this.cloud.currentUserId());}
  private stagePath(owner:string,id:string):string{
    return join(this.stageRoot,requireUuid(owner),requireUuid(id)+".bin");
  }
  private row(owner:string,id:string):PendingRow|undefined{
    return this.db.prepare("SELECT owner_id,file_id,filename,sha256,byte_length,base_version "+
      "FROM file_pending WHERE owner_id=? AND file_id=?").get(owner,id) as PendingRow|undefined;
  }
  pending():StagedPersonalFile[]{
    const owner=this.owner();
    return (this.db.prepare("SELECT owner_id,file_id,filename,sha256,byte_length,base_version "+
      "FROM file_pending WHERE owner_id=? ORDER BY created_at ASC")
      .all(owner) as unknown as PendingRow[]).map(row=>({
        fileId:requireUuid(row.file_id),filename:requirePersonalFileName(row.filename),
        sha256:requireFileHash(row.sha256),byteLength:requireFileSize(row.byte_length),
        baseVersion:requireFileVersion(row.base_version,true),
      }));
  }
  async overview():Promise<PersonalFilesOverview>{
    const owner=this.owner();
    const remote=await this.cloud.listPersonalFiles();
    if(this.owner()!==owner)throw Error("File sync owner changed");
    return {pending:this.pending(),remote};
  }
  /** file path is supplied ONLY by Main after native OpenFileDialog; NEVER by IPC. */
  async stagePickedFile(sourcePath:string,replace?:{fileId:string;version:number}):
    Promise<StagedPersonalFile>{
    if(this.inFlight)throw Error("Another file transfer is in progress");
    this.inFlight=true;
    try{
      const owner=this.owner();
      if(typeof sourcePath!=="string")throw Error("Invalid selected file");
      const filename=requirePersonalFileName(basename(sourcePath));
      const info=lstatSync(sourcePath);
      if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>MAX_SYNC_FILE_BYTES)
        throw Error("Only regular files between 1 byte and 1 MiB may be selected");
      const bytes=readFileSync(sourcePath);
      requireFileSize(bytes.byteLength);
      const remote=await this.cloud.listPersonalFiles();
      if(this.owner()!==owner)throw Error("Account changed while staging file");
      let fileId:string,baseVersion:number;
      if(replace){
        fileId=requireUuid(replace.fileId);
        baseVersion=requireFileVersion(replace.version);
        const current=remote.find(row=>row.fileId===fileId);
        if(!current||current.version!==baseVersion)
          throw Error("Remote file changed; refresh before replacing");
      }else{
        const total=remote.length+this.pending().filter(row=>row.baseVersion===0).length;
        if(total>=MAX_SYNC_FILE_COUNT)throw Error("Personal cloud file limit reached");
        fileId=randomUUID();baseVersion=0;
      }
      if(this.row(owner,fileId))throw Error("A local version is already staged; cancel it first");
      const hash=sha(bytes),location=this.stagePath(owner,fileId);
      mkdirSync(join(this.stageRoot,owner),{recursive:true,mode:0o700});
      writeFileSync(location,bytes,{flag:"wx",mode:0o600});
      try{
        this.db.prepare("INSERT INTO file_pending(owner_id,file_id,filename,sha256,"+
          "byte_length,base_version,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(owner,fileId,filename,hash,bytes.byteLength,baseVersion,new Date().toISOString());
      }catch(error){rmSync(location,{force:true});throw error;}
      return {fileId,filename,sha256:hash,byteLength:bytes.byteLength,baseVersion};
    }finally{this.inFlight=false;}
  }
  private discard(owner:string,fileId:string):void{
    this.db.prepare("DELETE FROM file_pending WHERE owner_id=? AND file_id=?").run(owner,fileId);
    rmSync(this.stagePath(owner,fileId),{force:true});
  }
  stopLocal(rawId:unknown):{stopped:true}{
    if(this.inFlight)throw Error("Wait until file transfer finishes");
    const owner=this.owner(),fileId=requireUuid(rawId);
    if(!this.row(owner,fileId))throw Error("No staged local file");
    this.discard(owner,fileId);
    return {stopped:true};
  }
  async upload(rawId:unknown):Promise<{status:"uploaded"|"conflict";version:number|null}>{
    if(this.inFlight)throw Error("Another file transfer is in progress");
    this.inFlight=true;
    try{
      const owner=this.owner(),fileId=requireUuid(rawId);
      const staged=this.row(owner,fileId);
      if(!staged)throw Error("Staged file no longer exists");
      const content=readFileSync(this.stagePath(owner,fileId));
      if(content.byteLength!==staged.byte_length||sha(content)!==staged.sha256)
        throw Error("Staged file checksum changed; upload has been blocked");
      const remote=await this.cloud.listPersonalFiles();
      if(this.owner()!==owner)throw Error("Account changed during upload");
      const existing=remote.find(row=>row.fileId===fileId);
      if(staged.base_version===0 && existing &&
        (existing.sha256!==staged.sha256||existing.filename!==staged.filename))
        return {status:"conflict",version:existing.version};
      if(staged.base_version>0 && (!existing||
        (existing.version!==staged.base_version &&
          (existing.sha256!==staged.sha256||existing.filename!==staged.filename))))
        return {status:"conflict",version:existing?.version??null};
      const result=await this.cloud.applyPersonalFile({
        fileId,baseVersion:staged.base_version,
        filename:staged.filename,sha256:staged.sha256,
        byteLength:staged.byte_length,base64:content.toString("base64"),
      });
      if(this.owner()!==owner)throw Error("Account changed during upload");
      if(result.status==="conflict")return {status:"conflict",version:result.version};
      this.discard(owner,fileId);
      return {status:"uploaded",version:result.version};
    }finally{this.inFlight=false;}
  }
  async download(rawId:unknown,rawVersion:unknown):Promise<{path:string;bytes:number}>{
    if(this.inFlight)throw Error("Another file transfer is in progress");
    this.inFlight=true;
    try{
      const owner=this.owner(),fileId=requireUuid(rawId),version=requireFileVersion(rawVersion);
      const list=await this.cloud.listPersonalFiles();
      const current=list.find(row=>row.fileId===fileId);
      if(!current||current.version!==version)
        throw Error("Remote file version changed; refresh before downloading");
      const payload=await this.cloud.readPersonalFile(fileId);
      if(this.owner()!==owner)throw Error("Account changed during download");
      if(payload.version!==current.version||payload.sha256!==current.sha256||
         payload.filename!==current.filename||payload.byteLength!==current.byteLength)
        throw Error("Remote file metadata changed during download");
      const bytes=Buffer.from(payload.base64,"base64");
      if(bytes.byteLength!==current.byteLength||sha(bytes)!==current.sha256)
        throw Error("Downloaded content checksum mismatch; file not saved");
      const folder=join(this.downloadRoot,owner);
      mkdirSync(folder,{recursive:true,mode:0o700});
      const location=join(folder,fileId+"-v"+version+"-"+current.filename);
      if(existsSync(location)){
        const existing=readFileSync(location);
        if(existing.byteLength!==bytes.byteLength||sha(existing)!==current.sha256)
          throw Error("Existing local download differs; refusing to overwrite");
      }else writeFileSync(location,bytes,{flag:"wx",mode:0o600});
      return {path:location,bytes:bytes.byteLength};
    }finally{this.inFlight=false;}
  }
  async deleteRemote(rawId:unknown,rawVersion:unknown):
    Promise<{status:"deleted"|"conflict";version:number|null}>{
    if(this.inFlight)throw Error("Another file transfer is in progress");
    this.inFlight=true;
    try{
      const owner=this.owner(),fileId=requireUuid(rawId),version=requireFileVersion(rawVersion);
      const result=await this.cloud.deletePersonalFile(fileId,version);
      if(this.owner()!==owner)throw Error("Account changed during file deletion");
      if(result.status==="conflict")return {status:"conflict",version:result.version};
      if(this.row(owner,fileId))this.discard(owner,fileId);
      return {status:"deleted",version:result.version};
    }finally{this.inFlight=false;}
  }
}
