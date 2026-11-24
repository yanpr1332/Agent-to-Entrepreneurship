import {describe,expect,it} from "vitest";
import {
  encodeEmbedding,embeddingCosine,fuseKnowledgeHits,
  parseLocalEmbeddingModel,passageHash,
} from "./knowledge-embeddings";
import type {KnowledgeSearchHit} from "../shared/knowledge-model";
const a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
const model={id:"intfloat/multilingual-e5-small",revision:"a".repeat(64),
  dimension:3,format:"float32-l2",protocol:"passage-query-v1"};
function hit(documentId:string,ordinal:number,matchType:"exact"|"fuzzy"|"semantic"):
  KnowledgeSearchHit{
  return {documentId,documentTitle:documentId,documentRevision:1,ordinal,
    excerpt:"Source citation",pageNumber:null,matchType};
}
describe("ALPHA-KB-005A pinned local embedding contract",()=>{
  it("accepts a version-pinned model but rejects unpinned revision and unknown fields",()=>{
    expect(parseLocalEmbeddingModel(model)).toEqual(model);
    for(const invalid of [
      {...model,revision:"latest"},{...model,revision:"b".repeat(63)},
      {...model,dimension:0},{...model,dimension:9999},
      {...model,protocol:"remote-api"},{...model,format:"f16"},
      {...model,id:"../secret"},{...model,extra:"network"},
    ])expect(()=>parseLocalEmbeddingModel(invalid)).toThrow();
  });
  it("encodes normalized little-endian Float32 with finite and zero checks",()=>{
    const a=encodeEmbedding([3,4,0],3);
    expect(a.length).toBe(12);
    expect(a.readFloatLE(0)).toBeCloseTo(.6,6);
    expect(a.readFloatLE(4)).toBeCloseTo(.8,6);
    expect(embeddingCosine(a,encodeEmbedding([6,8,0],3))).toBeCloseTo(1,5);
    expect(embeddingCosine(a,new Uint8Array(encodeEmbedding([6,8,0],3))))
      .toBeCloseTo(1,5);
    expect(embeddingCosine(a,encodeEmbedding([-3,-4,0],3))).toBeCloseTo(-1,5);
    for(const bad of [[0,0,0],[1,Number.NaN,0],[Infinity,0,0],[1,2],[1,1e90,0]])
      expect(()=>encodeEmbedding(bad,3)).toThrow();
    expect(()=>embeddingCosine(a,Buffer.alloc(8))).toThrow();
    const corrupt=Buffer.from(a);corrupt.writeFloatLE(Number.NaN,0);
    expect(()=>embeddingCosine(a,corrupt)).toThrow();
  });
  it("stabilizes evidence hashes and preserves exact citation rank through fusion",()=>{
    expect(passageHash("本文是原文")).toMatch(/^[0-9a-f]{64}$/);
    expect(passageHash("a")).not.toBe(passageHash("b"));
    const exact=hit(a,0,"exact"),fuzzy=hit(b,2,"fuzzy");
    const semantic=hit(b,1,"semantic");
    const fused=fuseKnowledgeHits([exact,fuzzy],[exact,semantic,fuzzy]);
    expect(fused[0]).toEqual(exact);
    expect(fused.map(x=>x.ordinal)).toEqual([0,2,1]);
    expect(new Set(fused.map(x=>x.documentId+":"+x.ordinal)).size)
      .toBe(fused.length);
    expect(fuseKnowledgeHits([exact,fuzzy],[semantic],1)).toEqual([exact]);
    expect(()=>fuseKnowledgeHits([],[],41)).toThrow();
  });
});
