import { requireKnowledgeId } from "./knowledge-model";

export type KnowledgeRelation = "related" | "supports" | "contrasts";
export type GraphEdgeStatus = "confirmed" | "pending";

export interface GraphNode {
  id:string;
  documentId:string;
  documentTitle:string;
  documentRevision:number;
  sourceOrdinal:number;
  sourcePage:number|null;
  sourceHash:string;
  evidence:string;
  title:string;
  note:string;
  needsReview:boolean;
  createdAt:string;
  updatedAt:string;
}
export interface GraphEdge {
  id:string;
  sourceId:string;
  targetId:string;
  relation:KnowledgeRelation;
  note:string;
  status:GraphEdgeStatus;
  createdAt:string;
}
export interface KnowledgeGraphSnapshot { nodes:GraphNode[]; edges:GraphEdge[]; }
export interface GraphNodeInput {
  documentId:string; sourceOrdinal:number; title:string; note:string;
}
export interface GraphEdgeInput {
  sourceId:string; targetId:string; relation:KnowledgeRelation; note:string;
}

function exact(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid graph input");
  const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!==keys.sort().join(","))throw Error("Invalid graph fields");
  return r;
}
function cleanText(value:unknown,max:number,required:boolean):string{
  if(typeof value!=="string"||value.length>max||
     /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||
     (required&&!value.trim()))throw Error("Invalid graph text");
  return value.trim();
}
export function parseGraphNode(value:unknown):GraphNodeInput{
  const r=exact(value,["documentId","sourceOrdinal","title","note"]);
  if(!Number.isSafeInteger(r.sourceOrdinal)||(r.sourceOrdinal as number)<0||
    (r.sourceOrdinal as number)>2500)throw Error("Invalid passage ordinal");
  return {documentId:requireKnowledgeId(r.documentId),
    sourceOrdinal:r.sourceOrdinal as number,
    title:cleanText(r.title,120,true),note:cleanText(r.note,600,false)};
}
export function parseGraphEdge(value:unknown):GraphEdgeInput{
  const r=exact(value,["sourceId","targetId","relation","note"]);
  const sourceId=requireKnowledgeId(r.sourceId),targetId=requireKnowledgeId(r.targetId);
  if(sourceId===targetId)throw Error("A relation must connect different nodes");
  if(r.relation!=="related"&&r.relation!=="supports"&&r.relation!=="contrasts")
    throw Error("Unsupported relation");
  return {sourceId,targetId,relation:r.relation as KnowledgeRelation,
    note:cleanText(r.note,600,false)};
}
