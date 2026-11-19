import type {KnowledgeFormat} from "../../shared/knowledge-model";

export type PreviewNode =
  | {kind:"text";value:string}
  | {kind:"element";tag:string;children:PreviewNode[]}
  | {kind:"math";tex:string;block:boolean};
const el=(tag:string,children:PreviewNode[]):PreviewNode=>({kind:"element",tag,children});
const txt=(value:string):PreviewNode=>({kind:"text",value});

const allowed=new Set([
  "p","div","span","strong","b","em","i","u","h1","h2","h3","h4","h5","h6",
  "ul","ol","li","pre","code","blockquote","hr","br",
  "table","thead","tbody","tr","td","th","sup","sub","a","del",
]);
function entities(value:string):string {
  const named:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi,
    (full,key:string)=>{
      if(key.startsWith("#")){
        const hex=key[1].toLowerCase()==="x",n=Number.parseInt(key.slice(hex?2:1),hex?16:10);
        return Number.isSafeInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)
          ?String.fromCodePoint(n):" ";
      }
      return named[key.toLowerCase()]??full;
    });
}

/** Deliberately small HTML tag allowlist; attributes are ALWAYS discarded.
 *  React receives plain text/element nodes, never a raw HTML sink.
 */
export function parseSafeHtml(source:string):PreviewNode[] {
  const clean=source.slice(0,80_000).replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<(script|style|iframe|object|embed|svg|template|noscript|head|form|video|audio|picture|canvas|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ")
    .replace(/<\s*(?:script|style|iframe|object|embed|svg|template|noscript|head|form|video|audio|picture|canvas|link|meta|img|input|source)\b[^>]*\/?>/gi," ");
  const root:{tag:string;children:PreviewNode[]}={tag:"div",children:[]};
  const stack=[root];let nodes=0;
  for(const part of clean.match(/<[^>]*>|[^<]+|</g)??[]){
    if(++nodes>6000)break;
    const closing=/^<\s*\/\s*([a-z][a-z0-9]*)[^>]*>$/i.exec(part);
    if(closing){
      let index=-1;
      for(let j=stack.length-1;j>=0;j--){
        if(stack[j].tag===closing[1].toLowerCase()){index=j;break;}
      }
      if(index>0)stack.length=index;
      continue;
    }
    const opening=/^<\s*([a-z][a-z0-9]*)\b[^>]*>$/i.exec(part);
    if(opening){
      const tag=opening[1].toLowerCase();
      if(!allowed.has(tag))continue;
      const item:{tag:string;children:PreviewNode[]}={tag,children:[]};
      stack[stack.length-1].children.push({kind:"element",...item});
      if(tag!=="br"&&tag!=="hr"&&!part.endsWith("/>")&&stack.length<40)
        stack.push(item);
      continue;
    }
    if(part[0]!=="<" || part==="<"){
      const value=entities(part);
      if(value.trim())stack[stack.length-1].children.push(txt(value));
    }
  }
  return root.children;
}

export function previewInline(value:string):PreviewNode[] {
  const result:PreviewNode[]=[];
  const pattern=/(\\\(([\s\S]*?)\\\)|\$([^$\n]+)\$|(\*\*|__)(.+?)\4|(?<!\*)\*([^*\n]+)\*|\x60([^\x60\n]+)\x60|\[([^\]]+)\]\(([^)]*)\))/g;
  let cursor=0,match:RegExpExecArray|null;
  while((match=pattern.exec(value))!==null){
    if(match.index>cursor)result.push(txt(value.slice(cursor,match.index)));
    if(match[2]!==undefined||match[3]!==undefined)
      result.push({kind:"math",tex:match[2]??match[3],block:false});
    else if(match[5]!==undefined)result.push(el("strong",previewInline(match[5])));
    else if(match[6]!==undefined)result.push(el("em",previewInline(match[6])));
    else if(match[7]!==undefined)result.push(el("code",[txt(match[7])]));
    else if(match[8]!==undefined)result.push(el("span",[txt(match[8])]));
    cursor=pattern.lastIndex;
  }
  if(cursor<value.length)result.push(txt(value.slice(cursor)));
  return result.length?result:[txt(value)];
}
export function parseMarkdown(source:string):PreviewNode[] {
  const lines=source.slice(0,80_000).replace(/\r\n?/g,"\n").split("\n");
  const result:PreviewNode[]=[];
  for(let i=0;i<lines.length&&result.length<3000;){
    const line=lines[i],trim=line.trim();
    if(!trim){i++;continue;}
    const fence=/^\s*(\x60{3,}|~{3,})/.exec(line);
    if(fence){
      const body:string[]=[];const marker=fence[1][0],size=fence[1].length;i++;
      while(i<lines.length&&!new RegExp("^\\s*"+marker+"{"+size+",}\\s*$").test(lines[i]))
        body.push(lines[i++]);
      if(i<lines.length)i++;
      result.push(el("pre",[el("code",[txt(body.join("\n"))])]));
      continue;
    }
    if(trim==="$$"||trim==="\\["){
      const marker=trim==="$$"?"$$":"\\]",parts:string[]=[];i++;
      while(i<lines.length&&lines[i].trim()!==marker)parts.push(lines[i++]);
      if(i<lines.length)i++;
      result.push({kind:"math",tex:parts.join("\n"),block:true});continue;
    }
    const singleMath=/^(?:\$\$([\s\S]+)\$\$|\\\[([\s\S]+)\\\])$/.exec(trim);
    if(singleMath){result.push({kind:"math",tex:singleMath[1]??singleMath[2],block:true});i++;continue;}
    const heading=/^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if(heading){result.push(el("h"+heading[1].length,previewInline(heading[2])));i++;continue;}
    if(/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)){result.push(el("hr",[]));i++;continue;}
    if(/^\s*>/.test(line)){
      const paragraph:string[]=[];
      while(i<lines.length&&/^\s*>/.test(lines[i]))paragraph.push(lines[i++].replace(/^\s*>\s?/,""));
      result.push(el("blockquote",[el("p",previewInline(paragraph.join(" "))) ]));continue;
    }
    if(/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)){
      const ordered=/^\s*\d+\.\s+/.test(line),items:PreviewNode[]=[];
      while(i<lines.length&&/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(lines[i]))
        items.push(el("li",previewInline(lines[i++].replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/,""))));
      result.push(el(ordered?"ol":"ul",items));continue;
    }
    if(line.includes("|")&&i+1<lines.length&&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i+1])){
      const rows:PreviewNode[]=[];
      const cells=(v:string)=>v.trim().replace(/^\||\|$/g,"").split("|").map(x=>x.trim());
      rows.push(el("tr",cells(line).map(c=>el("th",previewInline(c)))));
      i+=2;
      while(i<lines.length&&lines[i].includes("|")&&lines[i].trim())
        rows.push(el("tr",cells(lines[i++]).map(c=>el("td",previewInline(c)))));
      result.push(el("table",rows));continue;
    }
    if(/^\s*<[a-z]/i.test(line)){
      const html=[line];i++;
      while(i<lines.length&&lines[i].trim())html.push(lines[i++]);
      result.push(...parseSafeHtml(html.join("\n")));continue;
    }
    const paragraph=[line.trim()];i++;
    while(i<lines.length&&lines[i].trim()&&
      !/^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\x60{3,}|~{3,}|\$\$|\\\[)/.test(lines[i]))
      paragraph.push(lines[i++].trim());
    result.push(el("p",previewInline(paragraph.join(" "))));
  }
  return result;
}
export function parseLatex(source:string):PreviewNode[] {
  const lines=source.slice(0,80_000).replace(/\r\n?/g,"\n").split("\n");
  const result:PreviewNode[]=[];let list:PreviewNode[]|null=null,listTag="ul";
  const flush=()=>{if(list){result.push(el(listTag,list));list=null;}};
  for(let i=0;i<lines.length&&result.length<3000;i++){
    const raw=lines[i].trim();if(!raw||raw.startsWith("%"))continue;
    if(/^\\(?:documentclass|usepackage|title|author|date)\b/.test(raw)||
      /^\\(?:begin|end)\{document\}/.test(raw))continue;
    const section=/^\\(section|subsection|subsubsection)\*?\{([^}]*)\}/.exec(raw);
    if(section){flush();result.push(el(section[1]==="section"?"h2":section[1]==="subsection"?"h3":"h4",
      previewInline(section[2])));continue;}
    const start=/^\\begin\{(itemize|enumerate)\}/.exec(raw);
    if(start){flush();list=[];listTag=start[1]==="itemize"?"ul":"ol";continue;}
    if(/^\\end\{(itemize|enumerate)\}/.test(raw)){flush();continue;}
    if(raw.startsWith("\\item")){
      if(!list){list=[];listTag="ul";}
      list.push(el("li",previewInline(raw.slice(5).trim())));continue;
    }
    const mathStart=/^(?:\\begin\{(equation\*?|align\*?)\}|\\\[|\$\$)/.exec(raw);
    if(mathStart){
      flush();
      const end=mathStart[1]?"\\end{"+mathStart[1]+"}":raw.startsWith("$$")?"$$":"\\]";
      const parts=[raw.slice(mathStart[0].length)];let done=parts[0].includes(end);
      while(!done&&i+1<lines.length&&parts.length<300){
        const next=lines[++i];parts.push(next);done=next.includes(end);
      }
      result.push({kind:"math",tex:parts.join("\n").replace(end,"").trim(),block:true});continue;
    }
    flush();
    const formatted=raw.replace(/\\textbf\{([^}]*)\}/g,"**$1**")
      .replace(/\\(?:textit|emph)\{([^}]*)\}/g,"*$1*")
      .replace(/\\text\{([^}]*)\}/g,"$1");
    result.push(el("p",previewInline(formatted)));
  }
  flush();
  if(!result.length)result.push(el("p",[txt("此 TeX 文件没有可识别的基础文本环境；请切换到源码查看。")]));
  return result;
}
export function parsePreview(format:KnowledgeFormat,source:string):PreviewNode[] {
  return format==="html"?parseSafeHtml(source):
    format==="latex"?parseLatex(source):
    format==="markdown"?parseMarkdown(source):[el("pre",[txt(source.slice(0,80_000))])];
}
