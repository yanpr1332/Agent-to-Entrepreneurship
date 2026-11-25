import {createHash} from "node:crypto";
import {basename} from "node:path";
import {readSelectedKnowledgeFile,type SelectedKnowledgeText} from "./knowledge-import";
import type {SelectedKnowledgePdf} from "./pdf-extract";
import type {KnowledgeStore} from "./knowledge-store";
import {requireKnowledgeId,type KnowledgeBatchImportResult,
  type KnowledgeSourceAuditEntry,type KnowledgeSourceRefreshRequest,
  type KnowledgeSourceRefreshResult} from "../shared/knowledge-model";

export const MAX_KNOWLEDGE_BATCH_FILES=20;
type Source=SelectedKnowledgeText|SelectedKnowledgePdf;
export type KnowledgeFileReader=(path:string)=>Promise<Source>;

/** Never pass Renderer-supplied paths here: input paths come solely from a
 * native Electron open-file dialog or from previously imported store records. */
function requireNativeSelection(raw:unknown):string[]{
  if(!Array.isArray(raw)||raw.length<1||raw.length>MAX_KNOWLEDGE_BATCH_FILES||
    raw.some(v=>typeof v!=="string"||!v||v.length>4096))
    throw Error("Select 1–20 knowledge files using the native picker");
  return raw as string[];
}
function requireSourceIds(raw:unknown):string[]{
  if(!Array.isArray(raw)||raw.length<1||raw.length>MAX_KNOWLEDGE_BATCH_FILES)
    throw Error("Choose 1–20 imported documents to check");
  const ids=raw.map(requireKnowledgeId);
  if(new Set(ids).size!==ids.length)
    throw Error("Duplicate document identifiers are not allowed");
  return ids;
}
function safeReason(error:unknown):string{
  const code=error&&typeof error==="object"&&"code" in error?
    (error as {code?:unknown}).code:null;
  if(code==="ENOENT"||code==="ENOTDIR")return "源文件不存在或已移动";
  if(code==="EPERM"||code==="EACCES")return "无法读取源文件（权限不足）";
  return "源文件不可安全读取或格式/大小不符合要求";
}
function sourceDigest(source:Source):string{
  return source.format==="pdf"?source.fileHash:
    createHash("sha256").update(source.text.replace(/\r\n/g,"\n")).digest("hex");
}
function importSource(store:KnowledgeStore,source:Source){
  return source.format==="pdf"?store.importPdf(source):store.importText(source);
}
function validateExistingSource(
  source:Source,expected:{sourcePath:string;format:string}
):void{
  // Prevent a previously trusted path being redirected to another file by
  // symlink changes, including changed parent directory resolution.
  if(source.sourcePath!==expected.sourcePath||source.format!==expected.format)
    throw Error("Previously imported source path or format changed");
}

/** Fault isolation per picked file. One unreadable source must not discard
 * successfully imported siblings. Limits are checked BEFORE any IO. */
export async function importPickedKnowledgeFiles(
  store:KnowledgeStore,raw:unknown,reader:KnowledgeFileReader=readSelectedKnowledgeFile,
):Promise<KnowledgeBatchImportResult>{
  const paths=requireNativeSelection(raw),seen=new Set<string>();
  const items:KnowledgeBatchImportResult["items"]=[];
  for(const path of paths){
    const title=basename(path).slice(0,255);
    try{
      const source=await reader(path);
      if(seen.has(source.sourcePath)){
        items.push({title:source.title,status:"duplicate"});
        continue;
      }
      seen.add(source.sourcePath);
      const result=importSource(store,source);
      const status=result.changed?
        (result.document.revision===1?"added":"updated"):"unchanged";
      items.push({title:result.document.title,status,
        documentId:result.document.id});
    }catch(error){
      items.push({title,status:"failed",reason:safeReason(error)});
    }
  }
  return {selected:paths.length,items};
}

/** Only explicitly selected previously imported document IDs can be scanned.
 * This is a read-only operation: it does NOT change SQLite, cards, or vectors. */
export async function auditKnowledgeSources(
  store:KnowledgeStore,raw:unknown,reader:KnowledgeFileReader=readSelectedKnowledgeFile,
):Promise<KnowledgeSourceAuditEntry[]>{
  const ids=requireSourceIds(raw);
  const results:KnowledgeSourceAuditEntry[]=[];
  for(const id of ids){
    const doc=store.getDocument(id); // An arbitrary path cannot be provided.
    const entry:KnowledgeSourceAuditEntry={
      documentId:doc.id,title:doc.title,revision:doc.revision,status:"unreadable",
    };
    try{
      const source=await reader(doc.sourcePath);
      validateExistingSource(source,doc);
      const latest=store.getDocument(id);
      if(latest.revision!==doc.revision||latest.contentHash!==doc.contentHash){
        entry.status="stale";
      }else{
        const hash=sourceDigest(source);
        entry.status=hash===doc.contentHash?"unchanged":"changed";
        if(entry.status==="changed")entry.observedHash=hash;
      }
    }catch(error){
      const code=error&&typeof error==="object"&&"code" in error?
        (error as {code?:unknown}).code:null;
      entry.status=code==="ENOENT"||code==="ENOTDIR"?"missing":"unreadable";
    }
    results.push(entry);
  }
  return results;
}

export function parseSourceRefreshRequests(raw:unknown):KnowledgeSourceRefreshRequest[]{
  if(!Array.isArray(raw)||raw.length<1||raw.length>MAX_KNOWLEDGE_BATCH_FILES)
    throw Error("Choose 1–20 audited source changes to refresh");
  const ids=new Set<string>();
  return raw.map(item=>{
    if(!item||typeof item!=="object"||Array.isArray(item))
      throw Error("Invalid source refresh request");
    const v=item as Record<string,unknown>;
    if(Object.keys(v).sort().join(",")!=="documentId,expectedRevision,observedHash"||
      !Number.isSafeInteger(v.expectedRevision)||(v.expectedRevision as number)<1||
      typeof v.observedHash!=="string"||!/^[a-f0-9]{64}$/.test(v.observedHash))
      throw Error("Invalid source refresh request");
    const documentId=requireKnowledgeId(v.documentId);
    if(ids.has(documentId))throw Error("Duplicate refresh documents");
    ids.add(documentId);
    return {documentId,expectedRevision:v.expectedRevision as number,
      observedHash:v.observedHash as string};
  });
}

/** Commit only when both the document revision and exactly the checked disk
 * bytes still match the audit. Reads and imports are serial & individually
 * isolated; failures preserve previously indexed snapshots. */
export async function refreshAuditedKnowledgeSources(
  store:KnowledgeStore,raw:unknown,reader:KnowledgeFileReader=readSelectedKnowledgeFile,
):Promise<KnowledgeSourceRefreshResult>{
  const requests=parseSourceRefreshRequests(raw);
  const items:KnowledgeSourceRefreshResult["items"]=[];
  for(const request of requests){
    let title="已导入资料";
    try{
      const doc=store.getDocument(request.documentId);
      title=doc.title;
      if(doc.revision!==request.expectedRevision)
        throw Error("Document changed after audit");
      const source=await reader(doc.sourcePath);
      validateExistingSource(source,doc);
      if(sourceDigest(source)!==request.observedHash)
        throw Error("Source changed after audit");
      const current=store.getDocument(request.documentId);
      if(current.revision!==request.expectedRevision||
        current.contentHash!==doc.contentHash)
        throw Error("Document changed during refresh");
      const result=importSource(store,source);
      items.push({documentId:doc.id,title:result.document.title,
        status:result.changed?"updated":"unchanged"});
    }catch(error){
      // Avoid echoing source path, raw file names, parser data or stack traces.
      items.push({documentId:request.documentId,title,status:"failed",
        reason:error instanceof Error && /after audit|during refresh/.test(error.message)?
          "源文件或本地资料在检查后已变化，请重新检查":safeReason(error)});
    }
  }
  return {items};
}
