import {createElement,useMemo,type ReactNode} from "react";
import type {KnowledgeFormat} from "../../shared/knowledge-model";
import {parsePreview,type PreviewNode} from "./safe-preview-ast";
import {mathTree,type MathNode} from "./mathml-preview";

function renderMath(node:MathNode,key:number):ReactNode{
  return createElement(node.tag,{key},
    ...node.children.map((part,index)=>typeof part==="string"?part:renderMath(part,index)));
}
function renderNode(node:PreviewNode,key:number):ReactNode{
  if(node.kind==="text")return node.value;
  if(node.kind==="math"){
    const structure=mathTree(node.tex);
    return createElement("span",{key,className:node.block?"kb-equation-block":"kb-equation-inline"},
      createElement("math",{display:node.block?"block":"inline"},
        ...structure.children.map((child,i)=>
          typeof child==="string"?child:renderMath(child,i))));
  }
  return createElement(node.tag,{key},...node.children.map(renderNode));
}
/** No dangerouslySetInnerHTML, link href, image src, iframe or network access.
 * Source files remain unchanged and can always be viewed as plain text.
 */
export default function SafeKnowledgePreview({format,text}:{
  format:KnowledgeFormat;text:string;
}){
  const nodes=useMemo(()=>parsePreview(format,text),[format,text]);
  return <div className="kb-rendered-document" data-document-format={format}>
    {nodes.map(renderNode)}
    {text.length>80_000&&<p className="privacy-note">
      为控制离线阅读器的资源消耗，预览最多显示前 80,000 个字符。可切换到源码查看完整导入快照。
    </p>}
  </div>;
}
