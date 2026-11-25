import {describe,it,expect} from "vitest";
import {prepareKnowledgeRefresh} from "./knowledge-source-lifecycle-ui";

const ID="00000000-0000-4000-8000-000000000001";
describe("source review selection is explicit",()=>{
  it("includes only changed checked and hashed source records",()=>{
    const rows=[
      {documentId:ID,title:"Changed",revision:2,status:"changed" as const,
        observedHash:"a".repeat(64)},
      {documentId:"00000000-0000-4000-8000-000000000002",
        title:"Unchanged",revision:1,status:"unchanged" as const},
      {documentId:"00000000-0000-4000-8000-000000000003",
        title:"Unavailable",revision:1,status:"missing" as const},
    ];
    expect(prepareKnowledgeRefresh(rows,[ID,rows[1].documentId,rows[2].documentId]))
      .toEqual([{documentId:ID,expectedRevision:2,observedHash:"a".repeat(64)}]);
    expect(prepareKnowledgeRefresh(rows,[])).toEqual([]);
  });
});
