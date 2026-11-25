import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,writeFileSync}
  from "node:fs";
import {requireKnowledgeId,parseKnowledgeQuery,
  type KnowledgeEvaluationReport,type KnowledgeRetrievalScores}
  from "../shared/knowledge-model";
import {evaluateRetrieval,type RetrievalBenchmarkCase}
  from "./knowledge-retrieval-benchmark";
import type {KnowledgeSearchHit} from "../shared/knowledge-model";

const MAX_LABEL_BYTES=128*1024;
const EVIDENCE=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d*):((?:0|[1-9]\d*))$/i;
export function parseLocalEvaluationLabels(input:unknown):RetrievalBenchmarkCase[]{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw Error("Invalid local retrieval evaluation file");
  const data=input as Record<string,unknown>;
  if(Object.keys(data).sort().join(",")!=="cases,schema"||
    data.schema!==1||!Array.isArray(data.cases)||data.cases.length<1||
    data.cases.length>100)
    throw Error("Invalid local retrieval evaluation file");
  const cases:RetrievalBenchmarkCase[]=[];
  const ids=new Set<string>();
  for(const raw of data.cases){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw Error("Invalid local retrieval evaluation case");
    const entry=raw as Record<string,unknown>;
    if(Object.keys(entry).sort().join(",")!=="id,query,relevant"||
      typeof entry.id!=="string"||!/^[A-Za-z0-9._-]{1,64}$/.test(entry.id)||
      ids.has(entry.id)||!Array.isArray(entry.relevant)||
      entry.relevant.length<1||entry.relevant.length>20)
      throw Error("Invalid local retrieval evaluation case");
    ids.add(entry.id);
    const seen=new Set<string>();
    const relevant=entry.relevant.map(value=>{
      if(typeof value!=="string")throw Error("Invalid local evaluation source reference");
      const match=EVIDENCE.exec(value);
      if(!match||!Number.isSafeInteger(Number(match[2]))||
        !Number.isSafeInteger(Number(match[3]))||Number(match[3])>2500)
        throw Error("Invalid local evaluation source reference");
      const normalized=requireKnowledgeId(match[1]).toLowerCase()+
        ":"+Number(match[2])+":"+Number(match[3]);
      if(seen.has(normalized))throw Error("Duplicate local evaluation source reference");
      seen.add(normalized);
      return normalized;
    });
    cases.push({id:entry.id,query:parseKnowledgeQuery(entry.query),relevant});
  }
  return cases;
}
/** Check the current on-disk revision again at export/evaluation time.
 * Failed lookups are deliberately treated as stale references, not as
 * missing relevant evidence that may distort quality measurements. */
export function assertCurrentKnowledgeEvidence(
  key:string,lookup:(id:string,ordinal:number)=>{revision:number},
):void{
  const [id,revision,ordinal]=key.split(":");
  if(!id||!Number.isSafeInteger(Number(revision))||
    !Number.isSafeInteger(Number(ordinal)))
    throw Error("Invalid local evaluation source reference");
  try{
    const current=lookup(requireKnowledgeId(id),Number(ordinal));
    if(current.revision!==Number(revision))
      throw Error("Local evaluation labels reference an obsolete source revision");
  }catch{
    throw Error("Local evaluation labels reference an obsolete or missing passage");
  }
}

/** The save path must come exclusively from a trusted native SaveDialog.
 * Atomic exclusive creation prevents overwriting existing files or symlinks.
 * No raw local content is logged, exported to cloud, or sent to a model. */
export function saveLocalEvaluationLabels(
  file:string,input:unknown,assertEvidence:(key:string)=>void,
):number{
  if(typeof file!=="string"||!file.toLowerCase().endsWith(".json"))
    throw Error("Choose a local JSON labels file");
  const cases=parseLocalEvaluationLabels(input);
  for(const c of cases)for(const key of c.relevant)assertEvidence(key);
  const data=JSON.stringify({schema:1,cases},null,2)+"\n";
  if(Buffer.byteLength(data,"utf8")>MAX_LABEL_BYTES)
    throw Error("Local evaluation label file exceeds 128 KiB");
  writeFileSync(file,data,{flag:"wx",mode:0o600,encoding:"utf8"});
  return cases.length;
}

/** Only Main's native file picker supplies this path. Never accepts HTTP,
 * user-provided Renderer paths, symlinks or unlimited labelled datasets. */
export function readLocalEvaluationLabels(file:string):RetrievalBenchmarkCase[]{
  if(typeof file!=="string"||!file.toLowerCase().endsWith(".json"))
    throw Error("Choose a local JSON evaluation dataset");
  const before=lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||
    before.size<10||before.size>MAX_LABEL_BYTES)
    throw Error("Invalid or oversized local evaluation file");
  const fd=openSync(file,constants.O_RDONLY|
    (process.platform==="win32"?0:constants.O_NOFOLLOW));
  let contents:Buffer;
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_LABEL_BYTES)
      throw Error("Invalid local evaluation source");
    contents=readFileSync(fd);
  }finally{closeSync(fd);}
  if(contents.length>MAX_LABEL_BYTES)throw Error("Local evaluation file too large");
  const decoded=new TextDecoder("utf-8",{fatal:true}).decode(contents);
  return parseLocalEvaluationLabels(JSON.parse(decoded) as unknown);
}
function percentile(sorted:readonly number[],p:number):number{
  if(sorted.length===0)return 0;
  const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1));
  return Math.round(sorted[index]*100)/100;
}
function publicScores(source:ReturnType<typeof evaluateRetrieval>):KnowledgeRetrievalScores{
  return {precisionAt5:source.precisionAt5,recallAt10:source.recallAt10,
    mrrAt10:source.mrrAt10};
}
/** Evaluate only returned evidence keys, never the user text/content. A local
 * report contains aggregate metrics and timing, not raw query/answer excerpts.
 * Supply a synchronous evidence checker to reject stale labels from old
 * document revisions before a misleading score can be returned. */
export async function evaluateLocalRetrieval(
  cases:readonly RetrievalBenchmarkCase[],
  evaluate:{lexical:(query:string)=>KnowledgeSearchHit[];
    hybrid:(query:string)=>Promise<KnowledgeSearchHit[]>;
    assertCurrentEvidence:(key:string)=>void;
    modelId:string;modelRevision:string;indexed:number;skipped:number;pending:number;
  },
):Promise<KnowledgeEvaluationReport>{
  if(cases.length<1||cases.length>100)throw Error("Invalid evaluation query count");
  for(const c of cases)for(const key of c.relevant)evaluate.assertCurrentEvidence(key);
  const baseline:KnowledgeSearchHit[][]=[],hybrid:KnowledgeSearchHit[][]=[];
  const lexicalDurations:number[]=[],hybridDurations:number[]=[];
  let semanticCases=0;
  for(const entry of cases){
    let started=performance.now();
    const ordinary=evaluate.lexical(entry.query);
    lexicalDurations.push(performance.now()-started);
    started=performance.now();
    const blended=await evaluate.hybrid(entry.query);
    hybridDurations.push(performance.now()-started);
    if(blended.some(h=>h.matchType==="semantic"))semanticCases++;
    baseline.push(ordinary);hybrid.push(blended);
  }
  // Documents may be re-imported while asynchronous hybrid queries execute.
  // Reject the whole report if its human-labelled evidence became stale.
  for(const c of cases)for(const key of c.relevant)evaluate.assertCurrentEvidence(key);
  const lexicalMetric=evaluateRetrieval(cases,baseline);
  const hybridMetric=evaluateRetrieval(cases,hybrid);
  lexicalDurations.sort((a,b)=>a-b);hybridDurations.sort((a,b)=>a-b);
  return {cases:cases.length,modelId:evaluate.modelId,
    modelRevision:evaluate.modelRevision,
    indexed:evaluate.indexed,skipped:evaluate.skipped,pending:evaluate.pending,
    semanticCases,baseline:publicScores(lexicalMetric),
    hybrid:publicScores(hybridMetric),
    latencyMs:{lexicalP50:percentile(lexicalDurations,.5),
      lexicalP95:percentile(lexicalDurations,.95),
      hybridP50:percentile(hybridDurations,.5),
      hybridP95:percentile(hybridDurations,.95)}};
}
