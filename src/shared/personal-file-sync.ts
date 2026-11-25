/** V0.2 bounded personal file sync. This protocol is separate from the
 * personal-task/calendar JSON sync: no Canvas, mail, folder scanning or
 * knowledge base contents are ever automatically eligible. */
import {requireUuid} from "./cloud-model";

export const MAX_SYNC_FILE_BYTES=1_048_576;
export const MAX_SYNC_FILE_COUNT=20;
export const MAX_SYNC_FILE_NAME=128;
const SHA=/^[a-f0-9]{64}$/;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const EXT=/\.(md|txt|pdf|html|htm|tex|latex|csv|json|ics)$/i;

function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw Error("Invalid personal file response");
  return value as Record<string,unknown>;
}
function keys(v:Record<string,unknown>,expected:string[]):void{
  if(Object.keys(v).length!==expected.length||
    Object.keys(v).some(k=>!expected.includes(k)))
    throw Error("Unexpected personal file fields");
}
export function requirePersonalFileName(raw:unknown):string{
  if(typeof raw!=="string"||raw.trim()!==raw||raw.length<1||
    raw.length>MAX_SYNC_FILE_NAME||/[/\\\x00-\x1f\x7f]/.test(raw)||
    raw==="."||raw===".."||!EXT.test(raw))
    throw Error("Only bounded text, document or calendar file names are supported");
  return raw;
}
export function requireFileHash(raw:unknown):string{
  if(typeof raw!=="string"||!SHA.test(raw))throw Error("Invalid personal file SHA256");
  return raw;
}
export function requireFileSize(raw:unknown):number{
  if(!Number.isSafeInteger(raw)||(raw as number)<1||(raw as number)>MAX_SYNC_FILE_BYTES)
    throw Error("File must be between 1 byte and 1 MiB");
  return raw as number;
}
export function requireFileVersion(raw:unknown,allowZero=false):number{
  if(!Number.isSafeInteger(raw)||(raw as number)<(allowZero?0:1))
    throw Error("Invalid personal file version");
  return raw as number;
}
export interface RemotePersonalFile{
  fileId:string;filename:string;sha256:string;byteLength:number;
  version:number;updatedAt:string;
}
export interface PersonalFilePayload extends Omit<RemotePersonalFile,"updatedAt">{
  base64:string;
}
export interface PersonalFileApplyResult{
  status:"accepted"|"duplicate"|"conflict";version:number|null;
}
export interface StagedPersonalFile{
  fileId:string;filename:string;sha256:string;byteLength:number;
  baseVersion:number; /** 0 for files never uploaded */
}
export interface PersonalFilesOverview{
  pending:StagedPersonalFile[];
  remote:RemotePersonalFile[];
}
export function parsePersonalFileList(raw:unknown):RemotePersonalFile[]{
  if(!Array.isArray(raw)||raw.length>MAX_SYNC_FILE_COUNT)
    throw Error("Unexpected personal file list");
  const seen=new Set<string>();
  return raw.map(item=>{
    const v=object(item);
    keys(v,["fileId","filename","sha256","byteLength","version","updatedAt"]);
    const fileId=requireUuid(v.fileId),filename=requirePersonalFileName(v.filename),
      sha256=requireFileHash(v.sha256),byteLength=requireFileSize(v.byteLength),
      version=requireFileVersion(v.version);
    if(seen.has(fileId))throw Error("Duplicate personal file ID");
    seen.add(fileId);
    if(typeof v.updatedAt!=="string"||!TIME.test(v.updatedAt)||
      !Number.isFinite(Date.parse(v.updatedAt)))
      throw Error("Invalid personal file updated timestamp");
    return {fileId,filename,sha256,byteLength,version,updatedAt:v.updatedAt};
  });
}
export function parsePersonalFilePayload(raw:unknown):PersonalFilePayload{
  const v=object(raw);
  keys(v,["fileId","filename","sha256","byteLength","version","base64"]);
  const fileId=requireUuid(v.fileId),filename=requirePersonalFileName(v.filename),
    sha256=requireFileHash(v.sha256),byteLength=requireFileSize(v.byteLength),
    version=requireFileVersion(v.version);
  if(typeof v.base64!=="string"||v.base64.length>1_400_000||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.base64))
    throw Error("Invalid personal file encoding");
  return {fileId,filename,sha256,byteLength,version,base64:v.base64};
}
export function parsePersonalFileResult(raw:unknown):PersonalFileApplyResult{
  const v=object(raw);
  keys(v,["status","version"]);
  if(!["accepted","duplicate","conflict"].includes(String(v.status))||
    (v.version!==null&&(!Number.isSafeInteger(v.version)||(v.version as number)<1)))
    throw Error("Invalid personal file commit response");
  if(v.status!=="conflict"&&v.version===null)
    throw Error("Invalid personal file commit version");
  return {status:v.status as PersonalFileApplyResult["status"],
    version:v.version as number|null};
}
