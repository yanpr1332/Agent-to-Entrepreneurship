import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,writeFileSync,unlinkSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {KnowledgeStore} from "./knowledge-store";
import {readSelectedKnowledgeFile} from "./knowledge-import";
import {importPickedKnowledgeFiles,auditKnowledgeSources,
  refreshAuditedKnowledgeSources,parseSourceRefreshRequests,
  type KnowledgeFileReader} from "./knowledge-source-lifecycle";

const folders:string[]=[];
const stores:KnowledgeStore[]=[];
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-source-lifecycle-"));
  folders.push(dir);
  const store=new KnowledgeStore(join(dir,"knowledge.sqlite"));
  stores.push(store);
  return {dir,store};
}
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  while(folders.length)rmSync(folders.pop()!,{recursive:true,force:true});
});
function source(dir:string,name:string,body:string){
  const path=join(dir,name);writeFileSync(path,body);return path;
}
function refreshRequest(entry:{documentId:string;revision:number;observedHash?:string}){
  if(!entry.observedHash)throw Error("Expected audited change");
  return {documentId:entry.documentId,expectedRevision:entry.revision,
    observedHash:entry.observedHash};
}

describe("ALPHA-KB-007 native local knowledge source lifecycle",()=>{
  it("imports a bounded multi-selection, de-duplicates canonical paths and isolates invalid files",async()=>{
    const {dir,store}=fixture();
    const english=source(dir,"english.md","# ATP energy");
    const chinese=source(dir,"中文.txt","光合作用转化太阳能");
    const invalid=source(dir,"broken.md","\0forbidden");
    const result=await importPickedKnowledgeFiles(store,
      [english,english,chinese,invalid]);
    expect(result.selected).toBe(4);
    expect(result.items.map(x=>x.status)).toEqual([
      "added","duplicate","added","failed"]);
    expect(store.listDocuments()).toHaveLength(2);
    expect(store.search("energy")).toHaveLength(1);
    expect(store.search("光合作用")).toHaveLength(1);
    expect(result.items[3].reason).not.toContain(dir);
    expect(readFileSync(english,"utf8")).toBe("# ATP energy");
    expect((await importPickedKnowledgeFiles(store,[english])).items[0].status)
      .toBe("unchanged");
  });

  it("audits changed, missing and unreadable saved sources without mutating SQLite",async()=>{
    const {dir,store}=fixture();
    const a=source(dir,"a.md","mitochondria ATP");
    const b=source(dir,"b.txt","calculus");
    const c=source(dir,"c.tex","\\section{Math} derivative");
    const imported=await importPickedKnowledgeFiles(store,[a,b,c]);
    const ids=imported.items.map(x=>x.documentId!);
    const card=store.createCard({documentId:ids[0],sourceOrdinal:0,
      question:"Where ATP?",answer:"In mitochondria"});
    writeFileSync(a,"revised photosynthesis ATP");
    unlinkSync(b);
    writeFileSync(c,Buffer.from([0xc3,0x28]));
    const before=store.listDocuments();
    const audited=await auditKnowledgeSources(store,ids);
    expect(audited.map(x=>x.status)).toEqual(["changed","missing","unreadable"]);
    expect(audited[0].observedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audited[1].observedHash).toBeUndefined();
    expect(store.listDocuments()).toEqual(before);
    expect(store.listCards()[0]).toMatchObject({id:card.id,needsReview:false});
    expect(store.search("mitochondria")).toHaveLength(1);
  });

  it("refreshes only user-selected audited changed files and flags stale citations",async()=>{
    const {dir,store}=fixture();
    const a=source(dir,"biology.md","DNA polymerase copies template.");
    const b=source(dir,"math.md","calculus derivatives.");
    const added=await importPickedKnowledgeFiles(store,[a,b]);
    const ids=added.items.map(x=>x.documentId!);
    const old=store.createCard({documentId:ids[0],sourceOrdinal:0,
      question:"DNA?",answer:"Polymerase."});
    writeFileSync(a,"New DNA replication discovery.");
    writeFileSync(b,"Revised calculus notes.");
    const audits=await auditKnowledgeSources(store,ids);
    expect(audits.map(x=>x.status)).toEqual(["changed","changed"]);
    const refreshed=await refreshAuditedKnowledgeSources(store,[refreshRequest(audits[0])]);
    expect(refreshed.items).toMatchObject([{documentId:ids[0],status:"updated"}]);
    expect(store.getDocument(ids[0]).revision).toBe(2);
    expect(store.getDocument(ids[1]).revision).toBe(1);
    expect(store.listCards().find(c=>c.id===old.id)).toMatchObject({needsReview:true});
    expect(store.search("discovery")[0].documentId).toBe(ids[0]);
    expect(store.search("polymerase")).toHaveLength(0);
    expect(store.search("derivatives")).toHaveLength(1);
    const stillChanged=(await auditKnowledgeSources(store,ids)).map(x=>x.status);
    expect(stillChanged).toEqual(["unchanged","changed"]);
  });

  it("will not update if disk source changes between audit and confirmation",async()=>{
    const {dir,store}=fixture();
    const a=source(dir,"race.md","old evidence");
    const added=await importPickedKnowledgeFiles(store,[a]);
    const id=added.items[0].documentId!;
    writeFileSync(a,"first revision");
    const audit=(await auditKnowledgeSources(store,[id]))[0];
    writeFileSync(a,"second revision after preview");
    const result=await refreshAuditedKnowledgeSources(store,[refreshRequest(audit)]);
    expect(result.items[0]).toMatchObject({status:"failed"});
    expect(result.items[0].reason).toContain("重新检查");
    expect(store.getDocument(id)).toMatchObject({revision:1,text:"old evidence"});
    expect((await auditKnowledgeSources(store,[id]))[0].status).toBe("changed");
  });

  it("rejects concurrent local reimports and missing passages after audit without writes",async()=>{
    const {dir,store}=fixture();
    const a=source(dir,"concurrent.md","initial snapshot");
    const added=await importPickedKnowledgeFiles(store,[a]);
    const id=added.items[0].documentId!;
    writeFileSync(a,"source changed externally");
    const audit=(await auditKnowledgeSources(store,[id]))[0];
    store.importText({sourcePath:a,title:"concurrent.md",format:"markdown",
      text:"different user reimport"});
    const result=await refreshAuditedKnowledgeSources(store,[refreshRequest(audit)]);
    expect(result.items[0]).toMatchObject({status:"failed"});
    expect(store.getDocument(id)).toMatchObject({
      revision:2,text:"different user reimport"});
  });

  it("bounds and rejects forged renderer requests before any disk IO",async()=>{
    const {dir,store}=fixture();
    const file=source(dir,"note.md","trusted note");
    const reader=vi.fn<KnowledgeFileReader>(readSelectedKnowledgeFile);
    await expect(importPickedKnowledgeFiles(store,Array(21).fill(file),reader))
      .rejects.toThrow("1–20");
    await expect(importPickedKnowledgeFiles(store,[file,3],reader))
      .rejects.toThrow("1–20");
    await expect(auditKnowledgeSources(store,["/tmp/secret"],reader)).rejects.toThrow();
    await expect(auditKnowledgeSources(store,[],reader)).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(()=>parseSourceRefreshRequests([{documentId:"/etc/passwd",
      expectedRevision:1,observedHash:"a".repeat(64)}])).toThrow();
    const id=(await importPickedKnowledgeFiles(store,[file])).items[0].documentId!;
    const good={documentId:id,expectedRevision:1,observedHash:"a".repeat(64)};
    for(const forged of [
      {...good,sourcePath:"/tmp/malicious"},
      {...good,expectedRevision:1.5},
      {...good,observedHash:"bad"},
    ])expect(()=>parseSourceRefreshRequests([forged])).toThrow();
    expect(()=>parseSourceRefreshRequests([good,good])).toThrow("Duplicate");
    expect(()=>parseSourceRefreshRequests(Array(21).fill(good))).toThrow("1–20");
  });

  it("uses the same real PDF file hash as the knowledge store, preserving page-specific cards",async()=>{
    const {dir,store}=fixture();
    const path=join(dir,"paper.pdf");
    const pdf=(text:string)=>({
      sourcePath:path,title:"paper.pdf",format:"pdf" as const,
      pages:["Page one.",text],fileHash:createHash("sha256")
        .update(text).digest("hex"),byteLength:100,
    });
    let current=pdf("ATP production in mitochondria.");
    const read:KnowledgeFileReader=async()=>current;
    const added=await importPickedKnowledgeFiles(store,[path],read);
    const id=added.items[0].documentId!;
    const old=store.createCard({documentId:id,sourceOrdinal:1,
      question:"Energy?",answer:"ATP"});
    expect(old.sourcePage).toBe(2);
    expect((await auditKnowledgeSources(store,[id],read))[0].status).toBe("unchanged");
    current=pdf("New evidence about photosynthesis.");
    const audit=(await auditKnowledgeSources(store,[id],read))[0];
    expect(audit.status).toBe("changed");
    expect((await refreshAuditedKnowledgeSources(store,
      [refreshRequest(audit)],read)).items[0].status).toBe("updated");
    expect(store.getDocument(id).pageCount).toBe(2);
    expect(store.getPassage(id,1).pageNumber).toBe(2);
    expect(store.listCards()[0]).toMatchObject({needsReview:true,sourcePage:2});
  });

  it("rejects redirected source paths and avoids reading extra files",async()=>{
    const {dir,store}=fixture();
    const path=source(dir,"trusted.md","A trusted document.");
    const added=await importPickedKnowledgeFiles(store,[path]);
    const id=added.items[0].documentId!;
    const maliciousReader:KnowledgeFileReader=async()=>({
      sourcePath:"/elsewhere/redirected.md",title:"Unknown",
      format:"markdown",text:"Wrong source",
    });
    const audit=await auditKnowledgeSources(store,[id],maliciousReader);
    expect(audit[0].status).toBe("unreadable");
    expect(audit[0].observedHash).toBeUndefined();
    const bogus={documentId:id,expectedRevision:1,observedHash:"a".repeat(64)};
    expect((await refreshAuditedKnowledgeSources(store,[bogus],
      maliciousReader)).items[0].status).toBe("failed");
    expect(store.getDocument(id).text).toBe("A trusted document.");
  });
});
