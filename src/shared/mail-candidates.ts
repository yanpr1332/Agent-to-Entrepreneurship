import type { MailRecord } from "./mail-model";

/** Mail headers are untrusted hints, never evidence of an actual deadline. */
export type MailCandidateKind = "coursework" | "deadline" | "event";
export type MailCandidateDecision = "pending" | "ignored" | "accepted";
export type MailCandidateAction = "accept" | "ignore" | "reopen";

export interface MailCandidate extends MailRecord {
  kind: MailCandidateKind;
  decision: MailCandidateDecision;
  taskId: string | null;
}

export interface MailCandidateChoice {
  uid: number;
  uidValidity: number;
  action: MailCandidateAction;
}

export interface MailCandidateChoiceResult {
  action: MailCandidateAction;
  taskId: string | null;
  created: boolean;
}

const SUBJECT_RULES: ReadonlyArray<[MailCandidateKind, RegExp]> = [
  ["deadline", /截止|到期|提交时间|due[ -]?date|deadline|submission deadline/i],
  ["coursework", /作业|习题|实验报告|课程项目|小测|测验|考试|homework|assignment|coursework|quiz|\bexam\b|lab report/i],
  ["event", /报名|会议|答辩|讲座|面试|registration|\bmeeting\b|interview|seminar/i],
];

/** Transparent, conservative local heuristic; no mail body/AI/network access. */
export function classifyMailSubject(subject: string): MailCandidateKind | null {
  const value = subject.trim();
  if (!value || value.length > 500) return null;
  for (const [kind, test] of SUBJECT_RULES) {
    if (test.test(value)) return kind;
  }
  return null;
}

export function parseMailCandidateChoice(input: unknown): MailCandidateChoice {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid mail candidate action");
  }
  const payload = input as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "action,uid,uidValidity" ||
      !Number.isSafeInteger(payload.uid) || (payload.uid as number) < 1 ||
      !Number.isSafeInteger(payload.uidValidity) || (payload.uidValidity as number) < 1 ||
      (payload.action !== "accept" && payload.action !== "ignore" && payload.action !== "reopen")) {
    throw new Error("Invalid mail candidate action");
  }
  return {
    uid: payload.uid as number,
    uidValidity: payload.uidValidity as number,
    action: payload.action,
  };
}

export function suggestedTaskTitle(subject: string): string {
  const title = subject.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return title.slice(0, 120) || "邮件待办";
}
