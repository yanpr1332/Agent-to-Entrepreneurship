import {createHash} from "node:crypto";
import {readFileSync,lstatSync} from "node:fs";
import type {LocalEmbeddingModel,LocalEmbeddingProvider} from "./knowledge-embeddings";

export const MAX_LOCAL_VECTOR_FILE=32*1024*1024;
export const MAX_LOCAL_VOCAB=15000;
export const MAX_LOCAL_WORD_DIMENSION=384;
export const MAX_LOCAL_VECTOR_INPUT=2200;
export interface StaticWordVectors {
  readonly dimension:number;
  readonly vocabulary:ReadonlyMap<string,Float32Array>;
  readonly revision:string;
}
const WORD=/^[\p{L}\p{N}_\-]{1,64}$/u;
const HAN=/\p{Script=Han}/u;
function normalize(token:string):string{return token.normalize("NFKC").toLowerCase();}
export function loadStaticWordVectors(bytes:Uint8Array):StaticWordVectors{
  if(bytes.byteLength===0||bytes.byteLength>MAX_LOCAL_VECTOR_FILE)
    throw Error("Offline vector file is empty or exceeds 32 MiB");
  const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  if(content.includes("\r"))throw Error("Local word vector file must use UTF-8 LF");
  const lines=content.endsWith("\n")?content.slice(0,-1).split("\n"):content.split("\n");
  const header=lines.shift()??"";
  const match=/^([1-9][0-9]*) ([1-9][0-9]*)$/.exec(header);
  if(!match)throw Error("Invalid word-vector header; expected N D");
  const count=Number(match[1]),dimension=Number(match[2]);
  if(!Number.isSafeInteger(count)||count>MAX_LOCAL_VOCAB||
    !Number.isSafeInteger(dimension)||dimension<2||dimension>MAX_LOCAL_WORD_DIMENSION||
    lines.length!==count)throw Error("Offline vector dimensions or vocabulary exceed limits");
  const map=new Map<string,Float32Array>();
  for(const line of lines){
    const fields=line.split(" ");
    if(fields.length!==dimension+1||!WORD.test(fields[0]))
      throw Error("Invalid word-vector vocabulary row");
    const token=normalize(fields[0]);
    if(map.has(token))throw Error("Duplicate normalized vector token");
    const out=new Float32Array(dimension);
    let norm=0;
    for(let j=0;j<dimension;j++){
      // Reject JS's permissive Number(''), Infinity and number notation tricks.
      const field=fields[j+1];
      if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(field))
        throw Error("Invalid word-vector coordinate");
      const n=Number(field);
      if(!Number.isFinite(n)||Math.abs(n)>1e6)throw Error("Unsafe word-vector coordinate");
      out[j]=Math.fround(n);
      norm+=out[j]*out[j];
    }
    if(!Number.isFinite(norm)||norm<1e-12)
      throw Error("Zero or unsafe word-vector row");
    map.set(token,out);
  }
  return {dimension,vocabulary:map,
    revision:createHash("sha256").update(bytes).digest("hex")};
}
/** Only explicit local disk assets: no URL, network model loader or downloads.
 * We never accept source paths from Renderer IPC. */
export function readStaticWordVectors(path:string):StaticWordVectors{
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_LOCAL_VECTOR_FILE)
    throw Error("Unsafe or oversized local word vector file");
  return loadStaticWordVectors(readFileSync(path));
}
export function modelForStaticVectors(data:StaticWordVectors):LocalEmbeddingModel{
  return {id:"local/wordvec-"+data.revision.slice(0,20),revision:data.revision,
    dimension:data.dimension,format:"float32-l2",protocol:"passage-query-v1"};
}
export function staticWordVector(text:string,model:StaticWordVectors):number[]{
  if(typeof text!=="string"||!text.trim()||text.length>MAX_LOCAL_VECTOR_INPUT)
    throw Error("Offline embedding text exceeds local limits");
  const total=new Float64Array(model.dimension);
  let tokens=0;
  const words=normalize(text).match(/[\p{L}\p{N}]+/gu)??[];
  const take=(vector:Float32Array)=>{
    for(let i=0;i<total.length;i++)total[i]+=vector[i];
    tokens++;
  };
  for(const word of words){
    const direct=model.vocabulary.get(word);
    if(direct){take(direct);continue;}
    if(!HAN.test(word))continue;
    // Greedy CJK segmentation against the imported local dictionary. This
    // is NOT a trained tokenizer or an E5/BGE transformer.
    const chars=Array.from(word);
    for(let i=0;i<chars.length;){
      let matched=false;
      for(let n=Math.min(8,chars.length-i);n>=1;n--){
        const vec=model.vocabulary.get(chars.slice(i,i+n).join(""));
        if(vec){take(vec);i+=n;matched=true;break;}
      }
      if(!matched)i++;
    }
  }
  if(!tokens)throw Error("No known words in this offline embedding passage");
  return Array.from(total,v=>v/tokens);
}
/** Useful for isolated tests and offline benchmarking; production inference
 * uses the same parser/algorithm inside a dedicated Node Worker. */
export function staticWordVectorProvider(data:StaticWordVectors):LocalEmbeddingProvider{
  const check=(texts:readonly string[])=>{
    if(texts.length<1||texts.length>16)
      throw Error("Offline embedding batch exceeds limit");
  };
  return {model:modelForStaticVectors(data),
    async embed(texts){
      check(texts);
      return texts.map(text=>staticWordVector(text,data));
    },
    async embedPassages(texts){
      check(texts);
      return texts.map(text=>{
        try{return staticWordVector(text,data);}
        catch(error){
          if(error instanceof Error&&error.message==="No known words in this offline embedding passage")
            return null;
          throw error;
        }
      });
    },
  };
}
