import {randomUUID,createHash} from "node:crypto";
import {
  createReadStream,existsSync,lstatSync,mkdirSync,renameSync,rmSync,statSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {copyFile,readFile} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {RecoveryDatabase,RecoveryResult} from "../shared/recovery-model";

/** Only these five SQLite files are in existing user-initiated snapshots.
 * Team history / local credentials / raw source documents are NEVER copied. */
export const RESTORABLE_DATABASES={
  tasks:{source:"tasks.sqlite",destination:"study-anchor-tasks.sqlite",maxVersion:11},
  mail:{source:"mail.sqlite",destination:"study-anchor-mail.sqlite",maxVersion:0},
  knowledge:{source:"knowledge.sqlite",destination:"study-anchor-knowledge.sqlite",maxVersion:6},
  planning:{source:"planning.sqlite",destination:"study-anchor-planning.sqlite",maxVersion:2},
  calendar:{source:"calendar.sqlite",destination:"study-anchor-calendar.sqlite",maxVersion:5},
} as const;
type Kind=keyof typeof RESTORABLE_DATABASES;
const kinds=Object.keys(RESTORABLE_DATABASES) as Kind[];
const MAX_MANIFEST=16_384;
const MAX_DB_BYTES=2*1024*1024*1024;
export interface InspectedRecovery {
  createdAt:string;
  databases:RecoveryDatabase[];
  missing:string[];
  legacyManifest:boolean;
  /** Internal manifest-selected file names, never Renderer-provided. */
  sourceFiles:Partial<Record<Kind,string>>;
  expectedHashes:Partial<Record<Kind,string>>;
  /** Exact raw inventory hash, bound to the short-lived Main-only approval. */
  fingerprint:string;
}
const aliases=new Map<string,Kind>([
  ...kinds.map(name=>[RESTORABLE_DATABASES[name].source,name] as const),
  ...kinds.map(name=>[RESTORABLE_DATABASES[name].destination,name] as const),
  // Legacy pre-rename migration backups are read-only imported into modern
  // names. Never copy the old vaults or arbitrary old profile contents.
  ["ate-local.sqlite","tasks"],["ate-mail.sqlite","mail"],
  ["ate-knowledge.sqlite","knowledge"],["ate-plans.sqlite","planning"],
  ["ate-fixed-calendar.sqlite","calendar"],
]);
function inside(root:string,child:string):boolean{
  const r=relative(root,child);
  return r===""||(!r.startsWith(".."+sep)&&r!==".."&&!isAbsolute(r));
}
function realDirectory(path:string):void{
  if(!existsSync(path))throw Error("Backup directory does not exist");
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink())
    throw Error("Recovery folder must be a real directory, not a symlink");
}
function safeItem(path:string):void{
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)
    throw Error("Recovery files must be ordinary single-link files");
}
export async function sha256File(path:string):Promise<string>{
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest("hex");
}
function verifyDatabase(path:string,maxVersion:number):number{
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const ok=db.prepare("PRAGMA quick_check").get() as {quick_check:string}|undefined;
    if(ok?.quick_check!=="ok")throw Error("SQLite backup failed quick_check");
    const v=(db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(!Number.isInteger(v)||v<0||v>maxVersion)
      throw Error("Backup database schema is newer than this Study Anchor build");
    return v;
  }finally{db.close();}
}
type RecordV2={name:string;bytes:number;sha256:string;userVersion:number};
function parseManifest(raw:unknown):{createdAt:string;records:RecordV2[]|null;files:string[]}{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("Invalid backup manifest");
  const o=raw as Record<string,unknown>;
  if(o.schema!==1&&o.schema!==2)throw Error("Unknown backup manifest schema");
  if(typeof o.createdAt!=="string"||!Number.isFinite(Date.parse(o.createdAt))||
     typeof o.encryption!=="string"||o.encryption!=="none")
    throw Error("Unsupported or invalid backup manifest");
  let files:unknown=o.databases;
  if(o.schema===1&&typeof o.source==="string"&&files===undefined)
    files=[o.source];
  if(!Array.isArray(files)||files.length===0||files.length>kinds.length||
     !files.every(s=>typeof s==="string"))
    throw Error("Invalid snapshot database inventory");
  if(new Set(files).size!==files.length)throw Error("Duplicate backup file");
  const names=files as string[];
  const recognized=names.map(n=>aliases.get(n));
  if(recognized.some(x=>!x)||new Set(recognized).size!==recognized.length)
    throw Error("Unsupported or duplicate backup database");
  if(o.schema===1)return {createdAt:o.createdAt,files:names,records:null};
  if(!Array.isArray(o.files)||o.files.length!==names.length)
    throw Error("Backup checksum manifest is incomplete");
  const records:RecordV2[]=o.files.map((item:unknown)=>{
    if(!item||typeof item!=="object"||Array.isArray(item))
      throw Error("Malformed backup checksum entry");
    const r=item as Record<string,unknown>;
    if(Object.keys(r).sort().join(",")!=="bytes,name,sha256,userVersion"||
       typeof r.name!=="string"||
       !Number.isSafeInteger(r.bytes)||Number(r.bytes)<1||Number(r.bytes)>MAX_DB_BYTES||
       typeof r.sha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sha256)||
       !Number.isSafeInteger(r.userVersion)||Number(r.userVersion)<0)
      throw Error("Invalid backup checksum entry");
    return r as unknown as RecordV2;
  });
  if(records.some((r,i)=>r.name!==names[i]))
    throw Error("Backup checksum filenames do not match manifest");
  return {createdAt:o.createdAt,files:names,records};
}
/** Read-only verification. Supports pre-migration v1 snapshots and new v2
 * hashes. Never trusts names/paths in a manifest to escape its directory. */
export async function inspectRecoveryFolder(folder:string):Promise<InspectedRecovery>{
  const root=resolve(folder);realDirectory(root);
  const manifestPath=join(root,"manifest.json");safeItem(manifestPath);
  if(statSync(manifestPath).size>MAX_MANIFEST)throw Error("Backup manifest too large");
  let raw:unknown;
  try{raw=JSON.parse(await readFile(manifestPath,"utf8"));}
  catch{throw Error("Backup manifest cannot be parsed");}
  const parsed=parseManifest(raw);
  const result:RecoveryDatabase[]=[];
  const sourceFiles:Partial<Record<Kind,string>>={};
  const expectedHashes:Partial<Record<Kind,string>>={};
  const fingerprint=createHash("sha256").update(await readFile(manifestPath));
  for(const [i,filename] of parsed.files.entries()){
    if(basename(filename)!==filename||filename.includes("/")||filename.includes("\\"))
      throw Error("Invalid backup filename");
    const name=aliases.get(filename)!;
    const path=join(root,filename);safeItem(path);
    const size=statSync(path).size;
    if(!Number.isSafeInteger(size)||size<1||size>MAX_DB_BYTES)
      throw Error("Backup database size unsupported");
    const sha=await sha256File(path);
    const recorded=parsed.records?.[i];
    if(recorded&&(recorded.bytes!==size||recorded.sha256!==sha))
      throw Error("Backup checksum mismatch; recovery refused");
    const userVersion=verifyDatabase(path,RESTORABLE_DATABASES[name].maxVersion);
    if(recorded&&recorded.userVersion!==userVersion)
      throw Error("Backup schema version checksum mismatch");
    fingerprint.update(filename).update(sha);
    sourceFiles[name]=filename;
    expectedHashes[name]=sha;
    result.push({name,bytes:size,userVersion,sha256Verified:!!recorded});
  }
  return {createdAt:parsed.createdAt,databases:result,
    missing:kinds.filter(x=>!result.some(r=>r.name===x)),
    legacyManifest:parsed.records===null,sourceFiles,expectedHashes,
    fingerprint:fingerprint.digest("hex")};
}
function realNewDestination(path:string):string{
  // macOS /var is often a symlink to /private/var. Rejecting *every*
  // ancestor symlink rejects valid native save dialogs. Resolve the existing
  // parent, and compare the canonical destination to canonical live roots.
  const parent=realpathSync(dirname(path));
  if(!statSync(parent).isDirectory())throw Error("Recovery parent is not a directory");
  return join(parent,basename(path));
}
/** Creates an isolated, unopened new userData tree. No active profile files,
 * passwords, AI keys, team history, WAL, or symlink targets are overwritten. */
export async function recoverToNewProfile(input:{
  folder:string;destination:string;activeUserData:string;expectedFingerprint:string;
}):Promise<RecoveryResult>{
  const folder=resolve(input.folder),destination=resolve(input.destination),
    active=resolve(input.activeUserData);
  const canonicalTarget=realNewDestination(destination),
    canonicalActive=realpathSync(active),canonicalFolder=realpathSync(folder);
  if(destination===dirname(destination)||inside(canonicalActive,canonicalTarget)||
    inside(canonicalTarget,canonicalActive)||
    inside(canonicalFolder,canonicalTarget)||inside(canonicalTarget,canonicalFolder)||
    basename(destination)==="backups"||existsSync(destination))
    throw Error("Choose a nonexistent new profile outside live userData and its backups");
  const inspected=await inspectRecoveryFolder(folder);
  if(inspected.fingerprint!==input.expectedFingerprint)
    throw Error("Backup changed since review; inspect it again");
  const stage=join(dirname(destination),".study-anchor-restore-"+randomUUID());
  mkdirSync(stage,{recursive:false,mode:0o700});
  try{
    for(const record of inspected.databases){
      const source=inspected.sourceFiles[record.name];
      if(!source)throw Error("Backup file missing");
      const to=join(stage,RESTORABLE_DATABASES[record.name].destination);
      await copyFile(join(folder,source),to);
      if((await sha256File(to))!==inspected.expectedHashes[record.name])
        throw Error("Recovered copy failed checksum comparison");
      verifyDatabase(to,RESTORABLE_DATABASES[record.name].maxVersion);
    }
    writeFileSync(join(stage,"study-anchor-recovery.json"),JSON.stringify({
      schema:1,product:"Study Anchor",createdAt:new Date().toISOString(),
      sourceBackupAt:inspected.createdAt,isolated:true,
      databases:inspected.databases.map(r=>r.name),
      missing:inspected.missing,
      excludes:["credentials","cloud-team-history","ai-usage","offline-model-assets",
        "original-source-files","renderer-localStorage"],
    },null,2),{flag:"wx",mode:0o600});
    if(existsSync(destination))throw Error("Recovery destination appeared during import");
    renameSync(stage,destination);
    return {directory:destination,databases:inspected.databases.map(x=>x.name),isolated:true};
  }catch(error){
    rmSync(stage,{recursive:true,force:true});
    throw error;
  }
}
