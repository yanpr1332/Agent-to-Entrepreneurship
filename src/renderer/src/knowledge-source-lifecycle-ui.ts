import type {KnowledgeSourceAuditEntry,KnowledgeSourceRefreshRequest}
  from "../../shared/knowledge-model";

/** Only previously checked *changed* sources may be sent for confirmation. */
export function prepareKnowledgeRefresh(
  audit:readonly KnowledgeSourceAuditEntry[],chosen:readonly string[],
):KnowledgeSourceRefreshRequest[]{
  const selected=new Set(chosen);
  return audit.filter(entry=>entry.status==="changed"&&
    typeof entry.observedHash==="string"&&selected.has(entry.documentId))
    .map(entry=>({documentId:entry.documentId,expectedRevision:entry.revision,
      observedHash:entry.observedHash!}));
}
