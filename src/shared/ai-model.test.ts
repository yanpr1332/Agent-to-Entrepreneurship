import { describe, expect, it } from "vitest";
import {
  parseAIConnect, parseAIPrompt, parseAIApprovalId, parseAIModel,
  AI_DAILY_REQUEST_CAP, AI_MAX_PROMPT_CHARS,
} from "./ai-model";

describe("AI model and key boundaries", () => {
  it("accepts a supported GPT model identifier and rejects arbitrary endpoints", () => {
    expect(parseAIModel("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(() => parseAIModel("https://untrusted.example.org/v1")).toThrow();
    expect(() => parseAIModel("../secret")).toThrow();
    expect(() => parseAIModel("gpt-4\r\nAuthorization: evil")).toThrow();
  });
  it("validates a dedicated key but never returns it via a public status", () => {
    const config = parseAIConnect({ apiKey:"sk-"+"p".repeat(26), model:"gpt-4.1-mini" });
    expect(config.model).toBe("gpt-4.1-mini");
    expect(() => parseAIConnect({apiKey:"sk-abc",model:"gpt-4.1-mini"})).toThrow();
    expect(() => parseAIConnect({apiKey:"sk-"+"p".repeat(26),model:"gpt-4.1-mini",url:"http://localhost"})).toThrow();
  });
  it("bounds explicit user text and confirmation IDs", () => {
    expect(parseAIPrompt("  Explain the theorem  ")).toBe("Explain the theorem");
    expect(() => parseAIPrompt("x".repeat(AI_MAX_PROMPT_CHARS+1))).toThrow();
    expect(() => parseAIPrompt("hi\u0000")).toThrow();
    expect(() => parseAIApprovalId("bad")).toThrow();
    expect(AI_DAILY_REQUEST_CAP).toBeLessThanOrEqual(20);
  });
});
