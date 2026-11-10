import { describe, expect, it, afterEach } from "vitest";
import { KnowledgeStore } from "./knowledge-store";

const opened:KnowledgeStore[]=[];
function memory(){const db=new KnowledgeStore(":memory:");opened.push(db);return db;}
afterEach(()=>{while(opened.length)opened.pop()!.close();});

const first={sourcePath:"/tmp/biology.md",title:"Biology.md" as const,
  format:"markdown" as const,text:"# DNA Replication\nDNA polymerase reads a template strand.\n实验报告需核对证据。"};
const second={sourcePath:"/tmp/chemistry.txt",title:"Chemistry.txt",
  format:"text" as const,text:"ATP synthesis and energy transfer.\n要复习糖酵解这一章节。" };

describe("local knowledge FTS5 + source revisions",()=>{
  it("indexes real document excerpts and locates both English and Chinese searches",()=>{
    const db=memory();
    const imported=db.importText(first,new Date("2026-11-10T01:00:00Z"));
    expect(imported.changed).toBe(true);
    db.importText(second);
    expect(db.listDocuments()).toHaveLength(2);
    const english=db.search("polymerase");
    expect(english[0]).toMatchObject({
      documentId:imported.document.id,documentTitle:"Biology.md",ordinal:0,
    });
    expect(english[0].excerpt).toContain("DNA polymerase");
    expect(db.search("实验报告")[0].excerpt).toContain("实验报告");
    expect(db.search("糖酵")).toHaveLength(1); // 2-char fallback
    expect(db.search("unrelated topic")).toHaveLength(0);
    expect(db.getDocument(imported.document.id).text).toBe(first.text);
  });

  it("reimporting an unchanged file does not duplicate or alter revision",()=>{
    const db=memory();
    const created=db.importText(first);
    const identical=db.importText(first);
    expect(identical).toMatchObject({changed:false});
    expect(identical.document.id).toBe(created.document.id);
    expect(identical.document.revision).toBe(1);
    expect(db.listDocuments()).toHaveLength(1);
  });

  it("keeps a cited review card, but flags it for verification when source changes",()=>{
    const db=memory();
    const doc=db.importText(first).document;
    const card=db.createCard({documentId:doc.id,sourceOrdinal:0,
      question:"What does DNA polymerase read?",answer:"A template strand."},
      new Date("2026-11-10T08:00:00Z"));
    expect(card.evidence).toContain("DNA polymerase");
    expect(card.needsReview).toBe(false);
    const changed=db.importText({...first,text:"# DNA Replication\nRevised source contradicts earlier notes."});
    expect(changed.document.revision).toBe(2);
    expect(db.search("polymerase")).toEqual([]);
    expect(db.search("contradicts")[0].documentRevision).toBe(2);
    const previous=db.listCards()[0];
    expect(previous.id).toBe(card.id);
    expect(previous.needsReview).toBe(true);
    expect(previous.sourceHash).toBe(doc.contentHash);
    expect(previous.evidence).toContain("polymerase");
  });

  it("enforces a maximum source size and safely bounds search input",()=>{
    const db=memory();
    expect(()=>db.importText({...first,text:"a".repeat(2*1024*1024+1)}))
      .toThrow("2 MiB");
    expect(()=>db.search('a'.repeat(121))).toThrow();
    expect(()=>db.search('test" OR file*')).not.toThrow();
    expect(db.listDocuments()).toEqual([]);
  });

  it("deleting an indexed document removes its searchable rows and cards only",()=>{
    const db=memory();
    const a=db.importText(first).document,b=db.importText(second).document;
    db.createCard({documentId:a.id,sourceOrdinal:0,question:"DNA?",answer:"Yes."});
    db.createCard({documentId:b.id,sourceOrdinal:0,question:"ATP?",answer:"Yes."});
    expect(db.deleteDocument(a.id)).toBe(true);
    expect(db.search("polymerase")).toHaveLength(0);
    expect(db.search("synthesis")).toHaveLength(1);
    expect(db.listCards()).toHaveLength(1);
  });
});

describe("human-rated offline review scheduler",()=>{
  it("keeps authored answer and cited original, schedules only after a user rating",()=>{
    const db=memory();
    const doc=db.importText(first).document;
    const now=new Date("2026-11-10T10:00:00Z");
    const input={documentId:doc.id,sourceOrdinal:0,question:"What is DNA polymerase?",answer:"An enzyme."};
    const card=db.createCard(input,now);
    expect(db.createCard(input,now).id).toBe(card.id);
    expect(db.progress(now)).toEqual({due:1,total:1,reviewedToday:0});
    const rated=db.reviewCard(card.id,"good",now);
    expect(rated).toMatchObject({intervalDays:4,reviewCount:1,nextDue:"2026-11-14"});
    expect(db.progress(now)).toEqual({due:0,total:1,reviewedToday:1});
    // Repeated IPC clicks on same UTC day cannot award double review.
    expect(db.reviewCard(card.id,"easy",now).reviewCount).toBe(1);
    expect(()=>db.reviewCard(card.id,"good",new Date("2026-11-11T08:00:00Z")))
      .toThrow("not due");
    expect(db.reviewCard(card.id,"hard",new Date("2026-11-14T08:00:00Z")))
      .toMatchObject({intervalDays:6,reviewCount:2,nextDue:"2026-11-20"});
  });
  it("rejects forged review ratings and invalid passage ordinal",()=>{
    const db=memory(),doc=db.importText(first).document;
    expect(()=>db.createCard({documentId:doc.id,sourceOrdinal:999,question:"Q",answer:"A"}))
      .toThrow("no longer indexed");
    const card=db.createCard({documentId:doc.id,sourceOrdinal:0,question:"Q",answer:"A"});
    expect(()=>db.reviewCard(card.id,"excellent")).toThrow("Invalid review rating");
    expect(db.progress().total).toBe(1);
  });
});
