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

  it("indexes readable HTML and LaTeX text but preserves original sources",()=>{
    const db=memory();
    const html=db.importText({sourcePath:"/tmp/story.html",title:"story.html",
      format:"html",text:"<h1>Cell biology</h1><script>privateLeakToken</script><p>Ribosome function</p>"});
    const tex=db.importText({sourcePath:"/tmp/formula.tex",title:"formula.tex",
      format:"latex",text:"\\section{Linear Algebra}\nThe matrix rank is important."});
    expect(db.listDocuments().map(x=>x.format).sort()).toEqual(["html","latex"]);
    expect(db.getDocument(html.document.id).text).toContain("<script>");
    expect(db.getDocument(tex.document.id).format).toBe("latex");
    expect(db.search("Ribosome")[0].documentId).toBe(html.document.id);
    expect(db.search("privateLeakToken")).toEqual([]);
    expect(db.search("matrix rank")[0].documentId).toBe(tex.document.id);
  });
  it("blends exact and typo matches across documents and never duplicates citations",()=>{
    const db=memory();
    const exact=db.importText({sourcePath:"/tmp/exact.md",title:"Exact",
      format:"markdown",text:"DNA polymerase reads templates."}).document;
    const close=db.importText({sourcePath:"/tmp/near.md",title:"Near",
      format:"markdown",text:"DNA polymeraze acts on a template."}).document;
    const results=db.search("polymerase");
    expect(results.map(hit=>[hit.documentId,hit.matchType])).toEqual([
      [exact.id,"exact"],[close.id,"fuzzy"],
    ]);
    expect(new Set(results.map(hit=>hit.documentId+":"+hit.ordinal)).size)
      .toBe(results.length);
    expect(results[0].excerpt).toContain("polymerase");
  });
  it("tolerates a small typo or punctuation change with a separate fuzzy label",()=>{
    const db=memory();db.importText(first);
    expect(db.search("polymeraze")[0]).toMatchObject({
      documentTitle:"Biology.md",matchType:"fuzzy",
    });
    expect(db.search("polymerase")[0].matchType).toBe("exact");
    expect(db.search("unrelated topic")).toHaveLength(0);
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

describe("bounded local evidence catalog pagination",()=>{
  it("pages all passages deterministically without source paths",()=>{
    const db=memory();
    for(let i=0;i<5;i++)db.importText({sourcePath:"/private/"+i+".md",
      title:"Doc "+i,format:"markdown",text:"knowledge page "+i});
    const all=db.localEvidenceCatalog(5);
    const first=db.localEvidenceCatalog(2,0);
    const next=db.localEvidenceCatalog(2,2);
    const last=db.localEvidenceCatalog(2,4);
    expect([...first.items,...next.items,...last.items]).toEqual(all.items);
    expect(first.total).toBe(5);
    expect(db.localEvidenceCatalog(2,9)).toMatchObject({total:5,items:[]});
    expect(JSON.stringify(all)).not.toContain("/private/");
    for(const offset of [-1,100001,1.5,NaN])
      expect(()=>db.localEvidenceCatalog(50,offset)).toThrow("catalog page");
    expect(()=>db.localEvidenceCatalog(501,0)).toThrow("catalog page");
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
