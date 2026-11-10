import {afterEach,describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {KnowledgeStore} from "./knowledge-store";
import {backupBeforeMigration} from "./local-backup";

const stores:KnowledgeStore[]=[];
const folders:string[]=[];
function memory(){const db=new KnowledgeStore(":memory:");stores.push(db);return db;}
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  for(const path of folders.splice(0))rmSync(path,{recursive:true,force:true});
});
const pdf={
  sourcePath:"/tmp/course-material.pdf",title:"course-material.pdf",format:"pdf" as const,
  fileHash:"a".repeat(64),byteLength:1024,
  pages:["First page theorem about mitosis and cells.","Second page evidence for DNA transcription."],
};
describe("PDF page-specific text provenance and version 2 knowledge SQLite",()=>{
  it("stores page numbers for full-text hits, cited passages and review cards",()=>{
    const db=memory();
    const result=db.importPdf(pdf);
    expect(result.document).toMatchObject({format:"pdf",pageCount:2,chunkCount:2,revision:1});
    const one=db.search("mitosis");
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({pageNumber:1,ordinal:0,documentTitle:"course-material.pdf"});
    const two=db.search("transcription");
    expect(two[0]).toMatchObject({pageNumber:2,ordinal:1});
    const evidence=db.getPassage(result.document.id,two[0].ordinal);
    expect(evidence).toMatchObject({pageNumber:2,revision:1});
    expect(evidence.body).toContain("DNA transcription");
    const card=db.createCard({documentId:result.document.id,sourceOrdinal:two[0].ordinal,
      question:"What does page two cover?",answer:"DNA transcription."});
    expect(card.sourcePage).toBe(2);
    expect(card.evidence).toContain("DNA transcription");
    expect(db.getDocument(result.document.id).text).toContain("[Page 2]");
  });
  it("deduplicates unchanged files; reimport changes page citations and flags stale cards",()=>{
    const db=memory();
    const initial=db.importPdf(pdf).document;
    db.createCard({documentId:initial.id,sourceOrdinal:1,question:"Second page?",answer:"DNA."});
    expect(db.importPdf(pdf).changed).toBe(false);
    const updated=db.importPdf({...pdf,fileHash:"b".repeat(64),
      pages:["Rewritten first page about chemistry.","Rewritten second page about mitosis."]});
    expect(updated.document).toMatchObject({id:initial.id,revision:2,pageCount:2});
    expect(db.search("transcription")).toHaveLength(0);
    expect(db.search("mitosis")[0].pageNumber).toBe(2);
    expect(db.listCards()[0]).toMatchObject({needsReview:true,sourcePage:2});
  });
  it("preserves plain text sources and removes PDF metadata with a deleted document",()=>{
    const db=memory();
    const txt=db.importText({sourcePath:"/tmp/plain.txt",title:"plain.txt",format:"text",
      text:"Manual notes with original evidence."}).document;
    const doc=db.importPdf(pdf).document;
    expect(db.listDocuments().find(d=>d.id===txt.id)).toMatchObject({format:"text",pageCount:null});
    expect(db.getPassage(txt.id,0).pageNumber).toBeNull();
    expect(db.deleteDocument(doc.id)).toBe(true);
    expect(db.search("mitosis")).toHaveLength(0);
    expect(db.listDocuments()).toHaveLength(1);
  });
  it("rejects forged page structures and unbounded payloads before SQLite changes",()=>{
    const db=memory();
    expect(()=>db.importPdf({...pdf,fileHash:"invalid"})).toThrow();
    expect(()=>db.importPdf({...pdf,pages:[""]})).toThrow("selectable");
    expect(()=>db.importPdf({...pdf,pages:Array(121).fill("text")})).toThrow();
    expect(()=>db.importPdf({...pdf,byteLength:13*1024*1024})).toThrow();
    expect(db.listDocuments()).toHaveLength(0);
  });
  it("backs up old v1 data before the v1→v2 upgrade, preserving existing cards",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-kb-pdf-v1-"));folders.push(dir);
    const path=join(dir,"ate-knowledge.sqlite");
    const first=new KnowledgeStore(path);
    const doc=first.importText({sourcePath:"/tmp/legacy.md",title:"legacy.md",
      format:"markdown",text:"Important old material."}).document;
    first.createCard({documentId:doc.id,sourceOrdinal:0,question:"Old question",answer:"Old answer"});
    first.close();
    const raw=new DatabaseSync(path);
    raw.exec(`DROP TABLE knowledge_chunk_pages;
      DROP TABLE knowledge_pdf_sources;
      ALTER TABLE knowledge_cards DROP COLUMN source_page;
      PRAGMA user_version=1;`);
    raw.close();
    const backup=await backupBeforeMigration(dir,"ate-knowledge.sqlite",2);
    expect(backup).toBeTruthy();
    const oldCopy=new DatabaseSync(join(backup!,"ate-knowledge.sqlite"),{readOnly:true});
    expect((oldCopy.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(1);
    oldCopy.close();
    const restored=new KnowledgeStore(path);
    expect(restored.listDocuments()).toMatchObject([{id:doc.id,format:"markdown",pageCount:null}]);
    expect(restored.listCards()[0]).toMatchObject({question:"Old question",sourcePage:null});
    expect(restored.importPdf(pdf).document.format).toBe("pdf");
    restored.close();
  });
});
