export type KnowledgeFormat = "markdown" | "text" | "pdf" | "html" | "latex";
export interface KnowledgeDocument {
  id: string;
  title: string;
  format: KnowledgeFormat;
  contentHash: string;
  byteLength: number;
  chunkCount: number;
  importedAt: string;
  updatedAt: string;
  revision: number;
  /** Actual PDF page count; null for Markdown/TXT. */
  pageCount: number | null;
}
export interface KnowledgeSnapshot extends KnowledgeDocument {
  /** An indexed local copy; the original on disk is never rewritten. */
  text: string;
  sourcePath: string;
}
export interface KnowledgeSearchHit {
  documentId: string;
  documentTitle: string;
  documentRevision: number;
  ordinal: number;
  excerpt: string;
  pageNumber: number | null;
  matchType?: "exact" | "fuzzy" | "semantic";
}
export interface KnowledgeEmbeddingStatus {
  model: {
    id:string;revision:string;dimension:number;
    format:"float32-l2";protocol:"passage-query-v1";
  }|null;
  indexed:number;
  total:number;
  /** Persisted, revision-pinned passages with no dictionary vocabulary. */
  skipped?:number;
  /** Not yet indexed or explicitly classified as unencodable. */
  pending?:number;
  /** Index worker state; unavailable in older builds. */
  installed?:boolean;
  running?:boolean;
  engine?:"static-word-vectors"|null;
  error?:string|null;
}
export interface KnowledgeRetrievalScores {
  precisionAt5:number;
  recallAt10:number;
  mrrAt10:number;
}
/** A bounded, local-only page of evidence to support human relevance labelling. */
export interface KnowledgeEvidenceCatalogPage {
  total:number;
  items:Array<{evidenceKey:string;title:string;pageNumber:number|null;excerpt:string}>;
}
export interface KnowledgeLabelsSaveResult {path:string;cases:number;}
export interface KnowledgeLocalLabels {
  schema:1;
  cases:Array<{id:string;query:string;relevant:string[]}>;
}
export interface KnowledgeEvidenceExportResult {
  path:string;
  exported:number;
  total:number;
  truncated:boolean;
}
export interface KnowledgeEvaluationReport {
  cases:number;
  modelId:string;
  modelRevision:string;
  indexed:number;skipped:number;pending:number;
  semanticCases:number;
  baseline:KnowledgeRetrievalScores;
  hybrid:KnowledgeRetrievalScores;
  latencyMs:{
    lexicalP50:number;lexicalP95:number;
    hybridP50:number;hybridP95:number;
  };
}
export interface KnowledgePassage {
  documentId: string;
  documentTitle: string;
  revision: number;
  ordinal: number;
  pageNumber: number | null;
  body: string;
}
export type ReviewRating = "again" | "hard" | "good" | "easy";
export interface KnowledgeReviewCard {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceOrdinal: number;
  evidence: string;
  sourceHash: string;
  sourcePage: number | null;
  needsReview: boolean;
  question: string;
  answer: string;
  intervalDays: number;
  reviewCount: number;
  nextDue: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReviewCardInput { documentId: string; sourceOrdinal: number; question: string; answer: string; }
export interface ReviewProgress { due: number; total: number; reviewedToday: number; }

export function requireKnowledgeId(value: unknown): string {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid knowledge identifier");
  }
  return value;
}

export function parseKnowledgeQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120 ||
      /[\x00-\x1f\x7f]/.test(value)) throw new Error("Search must contain 1–120 characters");
  return value.trim();
}

function requireCardText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() ||
      value.length > maxLength || /\x00/.test(value)) {
    throw new Error("Invalid review question or answer");
  }
  return value.trim();
}

export function parseReviewCardInput(value: unknown): ReviewCardInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid review card request");
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "answer,documentId,question,sourceOrdinal" ||
      !Number.isSafeInteger(data.sourceOrdinal) || (data.sourceOrdinal as number) < 0) {
    throw new Error("Invalid review card request");
  }
  return {
    documentId: requireKnowledgeId(data.documentId),
    sourceOrdinal: data.sourceOrdinal as number,
    question: requireCardText(data.question, 500),
    answer: requireCardText(data.answer, 2000),
  };
}

export function parseReviewRating(value: unknown): ReviewRating {
  if (value !== "again" && value !== "hard" && value !== "good" && value !== "easy") {
    throw new Error("Invalid review rating");
  }
  return value;
}

/** Deterministic day-based Alpha scheduler; NOT an FSRS implementation. */
export function nextReviewInterval(previous: number, rating: ReviewRating): number {
  if (rating === "again") return 1;
  if (previous < 1) return rating === "hard" ? 2 : rating === "good" ? 4 : 7;
  const factor = rating === "hard" ? 1.5 : rating === "good" ? 2.2 : 3;
  return Math.min(365, Math.max(1, Math.ceil(previous * factor)));
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
export function dueDay(now: Date, days: number): string {
  const today = new Date(`${utcDay(now)}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() + days);
  return utcDay(today);
}

/** Paths are local userData snapshots, never exported remotely. */
export interface BackupResult {
  folder: string;
  createdAt: string;
  databases: string[];
  encryption: "none";
}
