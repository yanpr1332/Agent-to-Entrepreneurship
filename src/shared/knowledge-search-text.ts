import type { KnowledgeFormat } from "./knowledge-model";

/** Local-only readable text extraction. Original source is kept separately,
 *  and HTML/LaTeX commands are never evaluated. */
export function extractKnowledgeText(format:KnowledgeFormat,text:string):string {
  if(format==="html"){
    return decodeEntities(text
      .replace(/<!--[\s\S]*?-->/g," ")
      .replace(/<(script|style|iframe|object|embed|svg|template|head|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ")
      .replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim());
  }
  if(format==="latex"){
    return text
      .replace(/(^|\n)\s*%[^\n]*/g," ")
      .replace(/\\(?:documentclass|usepackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g," ")
      .replace(/\\(?:begin|end)\s*\{[^}]*\}/g," ")
      .replace(/\\(?:section|subsection|subsubsection|textbf|emph|textit|text)\s*\{([^}]*)\}/g," $1 ")
      .replace(/\\[a-zA-Z]+\*?/g," ").replace(/[{}$^_]/g," ")
      .replace(/\s+/g," ").trim();
  }
  if(format==="markdown"){
    return text.replace(/!\[([^\]]*)\]\([^)]*\)/g," $1 ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g," $1 ")
      .replace(/^\s{0,3}#{1,6}\s+/gm," ")
      .replace(/[*_~\x60]+/g," ")
      .replace(/\s+/g," ").trim();
  }
  return text;
}
function decodeEntities(raw:string):string {
  const named:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
  return raw.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi,(_all,name:string)=>{
    if(name.startsWith("#")){
      const hex=name.slice(1,2).toLowerCase()==="x";
      const number=Number.parseInt(name.slice(hex?2:1),hex?16:10);
      return Number.isSafeInteger(number)&&number>0&&number<=0x10ffff&&
        !(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):" ";
    }
    return named[name.toLowerCase()]??" ";
  });
}

export function normalizeFuzzy(text:string):string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu,"");
}

/** Approximate substring edit distance in O(queryLength * textLength) time.
 *  No AI, network access, wildcard SQL, or arbitrary regexp execution.
 */
export function fuzzySubstringMatch(query:string,raw:string,limit:number):
  {distance:number;end:number}|null {
  const q=Array.from(normalizeFuzzy(query));
  const h=Array.from(normalizeFuzzy(raw));
  if(q.length<4||q.length>60||h.length>3000)return null;
  let previous=Array.from({length:q.length+1},(_,i)=>i);
  let best=Number.POSITIVE_INFINITY,bestEnd=-1;
  for(let i=0;i<h.length;i++){
    const current=new Array<number>(q.length+1);
    current[0]=0;
    for(let k=1;k<=q.length;k++)
      current[k]=Math.min(previous[k]+1,current[k-1]+1,
        previous[k-1]+(q[k-1]===h[i]?0:1));
    if(current[q.length]<best){best=current[q.length];bestEnd=i+1;}
    if(best===0)break;
    previous=current;
  }
  return best<=limit?{distance:best,end:bestEnd}:null;
}

/** FTS5 trigram candidates only: all grams are quoted/parameterized, not SQL. */
export function fuzzyCandidateExpression(query:string):string|null {
  const normalized=Array.from(normalizeFuzzy(query));
  if(normalized.length<4||normalized.length>60)return null;
  const tokens=new Set<string>();
  for(let i=0;i<=normalized.length-3;i++){
    tokens.add(normalized.slice(i,i+3).join(""));
    if(tokens.size>=24)break;
  }
  return [...tokens].map(x=>'"'+x.replace(/"/g,'""')+'"').join(" OR ");
}
