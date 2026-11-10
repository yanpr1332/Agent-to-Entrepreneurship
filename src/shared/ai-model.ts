/** Provider v1: fixed OpenAI Responses API endpoint. No browser-side requests. */
export const AI_PROVIDER = "openai" as const;
export const AI_DEFAULT_MODEL = "gpt-4.1-mini";
export const AI_MAX_PROMPT_CHARS = 2000;
export const AI_OUTPUT_TOKEN_CAP = 512;
export const AI_DAILY_REQUEST_CAP = 12;
export const AI_PREVIEW_TTL_MS = 120_000;

export interface AIConnectInput { apiKey: string; model: string }
export interface AIPrivateSettings extends AIConnectInput {}
export interface AIStatus {
  connected: boolean;
  running: boolean;
  provider: typeof AI_PROVIDER;
  model: string | null;
  usedToday: number;
  remainingToday: number;
  dailyRequestLimit: number;
  maxOutputTokens: number;
  lastRequestAt: string | null;
}
export interface AIPreview {
  approvalId: string;
  model: string;
  prompt: string;
  expiresAt: string;
  maxOutputTokens: number;
}
export interface AIAnswer {
  text: string;
  model: string;
  createdAt: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI request");
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("Invalid AI request fields");
  }
  return fields;
}
export function parseAIModel(value: unknown): string {
  if (typeof value !== "string" || !/^gpt-[a-z0-9][a-z0-9._-]{1,63}$/i.test(value)) {
    throw new Error("Model must be an explicit GPT model ID");
  }
  return value;
}
export function parseAIConnect(input: unknown): AIConnectInput {
  const fields = exactObject(input, ["apiKey", "model"]);
  const key = fields.apiKey;
  if (typeof key !== "string" || !/^sk-[A-Za-z0-9_-]{12,500}$/.test(key)) {
    throw new Error("Invalid API key format; use a personal project key");
  }
  return { apiKey: key, model: parseAIModel(fields.model) };
}
export function parseAIPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() ||
      value.length > AI_MAX_PROMPT_CHARS || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error("Question must be 1–2000 text characters");
  }
  return value.trim();
}
export function parseAIApprovalId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid AI confirmation");
  }
  return value;
}
