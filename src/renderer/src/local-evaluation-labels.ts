import {parseKnowledgeQuery,type KnowledgeLocalLabels}
  from "../../shared/knowledge-model";

export type ManualLabelCase=KnowledgeLocalLabels["cases"][number];

/** UI-side constraints; Main validates the full object again before saving. */
export function appendManualLabelCase(
  existing:readonly ManualLabelCase[],query:unknown,
  selected:readonly string[],id:string,
):ManualLabelCase[]{
  if(existing.length>=100)throw Error("最多保存 100 条人工标注查询");
  const normalized=parseKnowledgeQuery(query);
  if(!/^[A-Za-z0-9._-]{1,64}$/.test(id)||
    existing.some(entry=>entry.id===id))
    throw Error("人工标注 ID 重复或格式错误");
  if(selected.length===0||selected.length>20||
    new Set(selected).size!==selected.length)
    throw Error("每条查询必须手动勾选 1–20 个不同证据");
  return [...existing,{id,query:normalized,relevant:[...selected]}];
}
