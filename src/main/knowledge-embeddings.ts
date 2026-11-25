import {createHash} from "node:crypto";
import type {KnowledgeSearchHit} from "../shared/knowledge-model";

/** Model revision must be a pinned, audited SHA-256 for actual local weights.
 * This versioned descriptor prevents mixing embeddings from different weights
 * or pooling/tokenization strategies.
 */
export interface LocalEmbeddingModel {
  id:string;
  revision:string;
  dimension:number;
  format:"float32-l2";
  protocol:"passage-query-v1";
}
export interface LocalEmbeddingProvider {
  readonly model:LocalEmbeddingModel;
  /** Never calls a remote API; a future worker must load explicitly
   * user-installed, hash-verified on-disk model assets only. */
  embed(texts:readonly string[],kind:"passage"|"query"):
    Promise<readonly (readonly number[])[]>;
  /** null means the passage has zero known vocabulary coverage. It must
   * never be converted to a fabricated nonzero vector; Main records a
   * revision-pinned skip instead. Query embeddings remain strict. */
  embedPassages?(texts:readonly string[]):
    Promise<readonly (readonly number[]|null)[]>;
}
export const MAX_LOCAL_EMBEDDINGS=6000;
export const MAX_EMBED_BATCH=16;
export const MAX_SEMANTIC_CANDIDATES=6000;
const MODEL_ID=/^[a-z0-9][a-z0-9._/-]{2,127}$/;
const SHA=/^[0-9a-f]{64}$/;

export function parseLocalEmbeddingModel(raw:unknown):LocalEmbeddingModel{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("Invalid local embedding model");
  const m=raw as Record<string,unknown>;
  if(Object.keys(m).sort().join(",")!=="dimension,format,id,protocol,revision"||
    typeof m.id!=="string"||!MODEL_ID.test(m.id)||
    typeof m.revision!=="string"||!SHA.test(m.revision)||
    !Number.isSafeInteger(m.dimension)||(m.dimension as number)<2||
    (m.dimension as number)>2048||m.format!=="float32-l2"||
    m.protocol!=="passage-query-v1")
    throw Error("Invalid pinned local embedding model");
  return {id:m.id,revision:m.revision,dimension:m.dimension as number,
    format:"float32-l2",protocol:"passage-query-v1"};
}

export function sameEmbeddingModel(a:LocalEmbeddingModel,b:LocalEmbeddingModel):boolean{
  return a.id===b.id&&a.revision===b.revision&&a.dimension===b.dimension&&
    a.format===b.format&&a.protocol===b.protocol;
}
export function passageHash(body:string):string{
  return createHash("sha256").update(body,"utf8").digest("hex");
}

/** Strict, L2-normalized Float32 encoding with finite and nonzero checks.
 * Persist little-endian portable bytes; reject partial results and NaN/Inf.
 */
export function encodeEmbedding(value:readonly number[],dimension:number):Buffer{
  if(!Array.isArray(value)||value.length!==dimension||dimension<2||dimension>2048)
    throw Error("Embedding dimension mismatch");
  let squared=0;
  for(const n of value){
    if(typeof n!=="number"||!Number.isFinite(n)||Math.abs(n)>1e12)
      throw Error("Invalid embedding coordinate");
    squared+=n*n;
  }
  const norm=Math.sqrt(squared);
  if(!Number.isFinite(norm)||norm<1e-12)throw Error("Embedding has zero or unsafe norm");
  const out=Buffer.alloc(dimension*4);
  let norm32=0;
  for(let i=0;i<dimension;i++){
    const n=Math.fround(value[i]/norm);
    out.writeFloatLE(n,i*4);norm32+=n*n;
  }
  if(!Number.isFinite(norm32)||Math.abs(norm32-1)>0.001)
    throw Error("Embedding normalization failed");
  return out;
}
export function embeddingCosine(query:Buffer,stored:Uint8Array):number{
  // node:sqlite returns BLOBs as Uint8Array (not necessarily Buffer).
  // Validate the exact byte count before reading little-endian floats.
  if(!Buffer.isBuffer(query)||!(stored instanceof Uint8Array)||
     query.length!==stored.length||query.length<8||query.length%4!==0)
    throw Error("Corrupt indexed embedding dimension");
  const bytes=Buffer.from(stored.buffer,stored.byteOffset,stored.byteLength);
  let dot=0;
  for(let p=0;p<query.length;p+=4){
    const q=query.readFloatLE(p),v=bytes.readFloatLE(p);
    if(!Number.isFinite(q)||!Number.isFinite(v))
      throw Error("Corrupt nonfinite indexed embedding");
    dot+=q*v;
  }
  return Math.max(-1,Math.min(1,dot));
}
function key(hit:KnowledgeSearchHit):string{
  return hit.documentId+":"+hit.documentRevision+":"+hit.ordinal;
}
/** Exact matches always win; the fuzzy/semantic tail uses rank-only RRF,
 * never raw cosine values that can overwhelm an exact term or citation. */
export function fuseKnowledgeHits(
  lexical:readonly KnowledgeSearchHit[],semantic:readonly KnowledgeSearchHit[],limit=40,
):KnowledgeSearchHit[]{
  if(!Number.isInteger(limit)||limit<1||limit>40)
    throw Error("Invalid hybrid search result limit");
  const exact:KnowledgeSearchHit[]=[];
  const seen=new Set<string>();
  for(const hit of lexical){
    if(hit.matchType!=="exact"&&hit.matchType!==undefined)continue;
    const id=key(hit);
    if(!seen.has(id)){exact.push(hit);seen.add(id);}
    if(exact.length===limit)return exact;
  }
  const tails=[lexical.filter(h=>h.matchType==="fuzzy"),
    semantic.filter(h=>h.matchType==="semantic")];
  const pool=new Map<string,{hit:KnowledgeSearchHit;score:number;first:number}>();
  tails.forEach((hits,source)=>{
    hits.forEach((hit,index)=>{
      const id=key(hit);
      if(seen.has(id))return;
      const prior=pool.get(id);
      const weight=source===0?1.1:1;
      const score=weight/(60+index+1);
      if(prior){prior.score+=score;return;}
      pool.set(id,{hit,score,first:source*1000+index});
    });
  });
  const sorted=[...pool.values()].sort((a,b)=>
    b.score-a.score||a.first-b.first||
    a.hit.documentId.localeCompare(b.hit.documentId)||a.hit.ordinal-b.hit.ordinal);
  return [...exact,...sorted.slice(0,limit-exact.length).map(x=>x.hit)];
}
