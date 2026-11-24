import {describe,expect,it} from "vitest";
import {evaluateRetrieval,retrievalEvidenceKey} from "./knowledge-retrieval-benchmark";
import type {KnowledgeSearchHit} from "../shared/knowledge-model";
const a="00000000-0000-4000-8000-000000000001";
const b="00000000-0000-4000-8000-000000000002";
function hit(id:string,ordinal:number):KnowledgeSearchHit{
  return {documentId:id,documentTitle:"Offline test document",
    documentRevision:1,ordinal,pageNumber:null,excerpt:"public synthetic evidence",
    matchType:"exact"};
}
describe("ALPHA-KB-005A evidence-level retrieval quality metrics",()=>{
  it("calculates transparent P@5, Recall@10 and MRR@10 for an offline baseline",()=>{
    const one=hit(a,0),two=hit(b,1),three=hit(b,2);
    const labels=[
      {id:"zh",query:"能量来源",relevant:[retrievalEvidenceKey(one),retrievalEvidenceKey(two)]},
      {id:"en",query:"find calculus",relevant:[retrievalEvidenceKey(three)]},
    ];
    const metrics=evaluateRetrieval(labels,[[two,one],[hit(a,99),three]]);
    expect(metrics.cases).toBe(2);
    expect(metrics.precisionAt5).toBeCloseTo(.3);
    expect(metrics.recallAt10).toBe(1);
    expect(metrics.mrrAt10).toBe(.75);
  });
  it("rejects duplicate results, no labels, and incorrectly paired benchmark cases",()=>{
    const entry={id:"first",query:"source",relevant:[retrievalEvidenceKey(hit(a,0))]};
    expect(()=>evaluateRetrieval([],[])).toThrow();
    expect(()=>evaluateRetrieval([entry],[])).toThrow();
    expect(()=>evaluateRetrieval([entry],[[hit(a,0),hit(a,0)]])).toThrow("Duplicate");
    expect(()=>evaluateRetrieval([{...entry,relevant:[]}],[[]])).toThrow("labels");
  });
});
