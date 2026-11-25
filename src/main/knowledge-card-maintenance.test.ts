import {afterEach,describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {KnowledgeStore} from "./knowledge-store";
import {backupBeforeMigration} from "./local-backup";
import {parseReviewCardEdit,parseReviewCardRebind} from "../shared/knowledge-model";

const opened:KnowledgeStore[]=[];
const folders:string[]=[];
const NOW=new Date("2026-11-10T08:00:00.000Z");
const NEXT=new Date("2026-11-11T08:00:00.000Z");
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"sa-review-source-"));folders.push(dir);
  const path=join(dir,"knowledge.sqlite");
  const store=new KnowledgeStore(path);opened.push(store);
  return {dir,path,store};
}
function close(store:KnowledgeStore):void{
  opened.splice(opened.indexOf(store),1);store.close();
}
const md=(text:string)=>({sourcePath:"/private/biology.md",title:"Biology",
  format:"markdown" as const,text});
const edit=(id:string,expectedUpdatedAt:string,question:string,answer:string)=>({
  id,expectedUpdatedAt,question,answer,
});
const rebind=(id:string,expectedUpdatedAt:string,expectedDocumentRevision:number,
  sourceOrdinal=0)=>({
  id,expectedUpdatedAt,expectedDocumentRevision,sourceOrdinal,
  confirmation:"CONFIRM_CURRENT_SOURCE_EVIDENCE" as const,
});
afterEach(()=>{
  while(opened.length)opened.pop()!.close();
  while(folders.length)rmSync(folders.pop()!,{force:true,recursive:true});
});
describe("KB-006 review cards, editing and explicit evidence re-confirmation",()=>{
  it("edits content without resetting schedule, ratings, citation or source status",()=>{
    const {store}=fixture();
    const source=store.importText(md("DNA polymerase template strand.")).document;
    const card=store.createCard({documentId:source.id,sourceOrdinal:0,
      question:"Old question",answer:"Old answer"},NOW);
    const rated=store.reviewCard(card.id,"good",NOW);
    expect(rated).toMatchObject({reviewCount:1,intervalDays:4,nextDue:"2026-11-14"});
    const revised=store.editCard(edit(card.id,rated.updatedAt,
      "What strand?","A template strand."),NEXT);
    expect(revised).toMatchObject({id:card.id,reviewCount:1,intervalDays:4,
      nextDue:"2026-11-14",sourceHash:source.contentHash,needsReview:false,
      question:"What strand?",answer:"A template strand."});
    expect(revised.evidence).toContain("polymerase");
    expect(store.cardEvidenceHistory(card.id)).toEqual([]);
    expect(store.progress(NEXT)).toMatchObject({due:0,total:1});
    expect(()=>store.editCard(edit(card.id,rated.updatedAt,"Lost","Lost"),NEXT))
      .toThrow("reload");
    expect(()=>store.editCard(edit(card.id,revised.updatedAt,"","answer"),NEXT))
      .toThrow("Invalid");
    expect(store.listCards()[0].question).toBe("What strand?");
  });

  it("rejects invalid/malicious shapes and source confirmation without explicit consent",()=>{
    const {store}=fixture();
    const doc=store.importText(md("Energy conversion in mitochondria.")).document;
    const card=store.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"Energy?",answer:"ATP."},NOW);
    expect(()=>parseReviewCardEdit({...edit(card.id,card.updatedAt,"Q","A"),
      sourceOrdinal:1})).toThrow("Invalid");
    expect(()=>parseReviewCardRebind({...rebind(card.id,card.updatedAt,1),
      confirmation:"yes"})).toThrow("Invalid");
    expect(()=>store.rebindCardEvidence({
      ...rebind(card.id,card.updatedAt,1),sourceOrdinal:2501})).toThrow("Invalid");
    expect(()=>store.rebindCardEvidence({
      ...rebind(card.id,card.updatedAt,1),expectedDocumentRevision:0}))
      .toThrow("Invalid");
    expect(store.cardEvidenceHistory(card.id)).toEqual([]);
  });

  it("blocks grading stale cards until user explicitly previews and rebinds current evidence",()=>{
    const {store}=fixture();
    const doc=store.importText(md("DNA polymerase uses a template strand.")).document;
    const original=store.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"DNA?",answer:"Template."},NOW);
    store.importText(md("DNA polymerase now revised with new findings."));
    const stale=store.listCards()[0];
    expect(stale.needsReview).toBe(true);
    expect(stale.evidence).toContain("template strand");
    expect(()=>store.reviewCard(stale.id,"good",NEXT)).toThrow("reviewed");
    expect(()=>store.rebindCardEvidence(rebind(stale.id,stale.updatedAt,1),NEXT))
      .toThrow("changed after preview");
    expect(store.cardEvidenceHistory(stale.id)).toEqual([]);
    const updated=store.rebindCardEvidence(rebind(stale.id,stale.updatedAt,2),NEXT);
    expect(updated).toMatchObject({id:original.id,sourceOrdinal:0,
      needsReview:false,sourceHash:store.getDocument(doc.id).contentHash,
      sourcePage:null});
    expect(updated.evidence).toContain("new findings");
    expect(store.cardEvidenceHistory(stale.id)).toMatchObject([{
      evidence:original.evidence,sourceHash:original.sourceHash,sourceOrdinal:0,
      sourcePage:null,archivedAt:NEXT.toISOString(),
    }]);
    expect(()=>store.rebindCardEvidence(rebind(stale.id,stale.updatedAt,2),NEXT))
      .toThrow("reload");
    expect(store.cardEvidenceHistory(stale.id)).toHaveLength(1);
    expect(store.reviewCard(stale.id,"hard",NEXT)).toMatchObject({
      reviewCount:1,intervalDays:2,nextDue:"2026-11-13"});
  });

  it("rejects deleted/missing passages and revision races without archiving partial changes",()=>{
    const {store}=fixture();
    const doc=store.importText(md("Cell energy molecule.")).document;
    const card=store.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"What molecule?",answer:"ATP"},NOW);
    store.importText(md("Changed source text with only one passage."));
    const stale=store.listCards()[0];
    expect(()=>store.rebindCardEvidence(rebind(card.id,stale.updatedAt,2,99),NEXT))
      .toThrow("no longer exists");
    expect(store.cardEvidenceHistory(card.id)).toHaveLength(0);
    expect(store.listCards()[0].needsReview).toBe(true);
    store.importText(md("Another new revision."));
    expect(()=>store.rebindCardEvidence(rebind(card.id,stale.updatedAt,2),NEXT))
      .toThrow("changed after preview");
    expect(store.cardEvidenceHistory(card.id)).toHaveLength(0);
  });

  it("preserves archived PDF page references and review history over restart",()=>{
    const {path,store}=fixture();
    const source={sourcePath:"/private/paper.pdf",title:"Paper",fileHash:"a".repeat(64),
      byteLength:500,pages:["Intro to biology.","Evidence about energy on page two."]};
    const doc=store.importPdf(source).document;
    const card=store.createCard({documentId:doc.id,sourceOrdinal:1,
      question:"What about energy?",answer:"Energy on page two."},NOW);
    const rated=store.reviewCard(card.id,"good",NOW);
    const changed=store.importPdf({...source,fileHash:"b".repeat(64),
      pages:["Different first page.","New evidence about ATP on page two."]}).document;
    expect(changed.revision).toBe(2);
    const rebound=store.rebindCardEvidence(rebind(card.id,rated.updatedAt,2,1),NEXT);
    expect(rebound).toMatchObject({sourcePage:2,reviewCount:1,nextDue:"2026-11-14"});
    expect(store.cardEvidenceHistory(card.id)[0]).toMatchObject({sourcePage:2,
      evidence:card.evidence});
    close(store);
    const reopened=new KnowledgeStore(path);opened.push(reopened);
    expect(reopened.cardEvidenceHistory(card.id)[0].sourcePage).toBe(2);
    expect(reopened.listCards()[0]).toMatchObject({needsReview:false,
      reviewCount:1,nextDue:"2026-11-14"});
    expect(reopened.deleteDocument(doc.id)).toBe(true);
    expect(reopened.listCards()).toEqual([]);
    expect(()=>reopened.cardEvidenceHistory(card.id)).toThrow("not found");
  });

  it("migrates existing SQLite v5 cards to v6 after an inspectable WAL-aware backup",async()=>{
    const {dir,path,store}=fixture();
    const doc=store.importText(md("Legacy revision five knowledge.")).document;
    const card=store.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"Legacy?",answer:"Yes."},NOW);
    close(store);
    const prior=new DatabaseSync(path);
    prior.exec("DROP TABLE knowledge_card_evidence_history; PRAGMA user_version=5");
    prior.close();
    const backup=await backupBeforeMigration(dir,"knowledge.sqlite",6);
    expect(backup).toBeTruthy();
    const before=new DatabaseSync(join(backup!,"knowledge.sqlite"),{readOnly:true});
    expect((before.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(5);
    before.close();
    const restored=new KnowledgeStore(path);opened.push(restored);
    expect(restored.listCards()[0]).toMatchObject({id:card.id,question:"Legacy?"});
    expect(restored.cardEvidenceHistory(card.id)).toEqual([]);
    const raw=new DatabaseSync(path,{readOnly:true});
    expect((raw.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(6);
    raw.close();
  });
});
