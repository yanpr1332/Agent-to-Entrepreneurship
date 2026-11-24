import type {KnowledgeSearchHit} from "../shared/knowledge-model";

export interface RetrievalBenchmarkCase {
  id:string;
  query:string;
  /** Canonical document UUID + revision + ordinal evidence identities. */
  relevant:readonly string[];
}
export interface RetrievalBenchmarkResult {
  cases:number;
  precisionAt5:number;
  recallAt10:number;
  mrrAt10:number;
}
export function retrievalEvidenceKey(hit:KnowledgeSearchHit):string{
  return hit.documentId+":"+hit.documentRevision+":"+hit.ordinal;
}
/** Minimal deterministic benchmark helper for the eventual opt-in on-device
 * model. This never measures/claims model quality without real local runs.
 */
export function evaluateRetrieval(
  cases:readonly RetrievalBenchmarkCase[],
  results:readonly (readonly KnowledgeSearchHit[])[],
):RetrievalBenchmarkResult{
  if(cases.length===0||cases.length!==results.length||cases.length>200)
    throw Error("Invalid semantic benchmark size");
  let p5=0,r10=0,mrr10=0;
  for(let i=0;i<cases.length;i++){
    const entry=cases[i];
    if(!entry.id||!entry.query||entry.relevant.length===0||
      entry.relevant.length>1000||new Set(entry.relevant).size!==entry.relevant.length)
      throw Error("Invalid benchmark relevance labels");
    const found=results[i].map(retrievalEvidenceKey);
    if(new Set(found).size!==found.length)
      throw Error("Duplicate source passage in evaluated results");
    const relevant=new Set(entry.relevant);
    const at5=found.slice(0,5).filter(k=>relevant.has(k)).length;
    const at10=found.slice(0,10).filter(k=>relevant.has(k)).length;
    p5+=at5/5;
    r10+=at10/relevant.size;
    const first=found.slice(0,10).findIndex(k=>relevant.has(k));
    if(first>=0)mrr10+=1/(first+1);
  }
  return {cases:cases.length,precisionAt5:p5/cases.length,
    recallAt10:r10/cases.length,mrrAt10:mrr10/cases.length};
}
