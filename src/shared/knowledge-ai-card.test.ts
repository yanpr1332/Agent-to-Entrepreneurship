import { describe, expect, it } from "vitest";
import { buildFlashcardRequest, parseFlashcardCandidate } from "./knowledge-ai-card";
const passage={
  documentId:"b816133c-f901-4e08-a2c1-9500e83c1084",
  documentTitle:"Physics",ordinal:2,revision:4,pageNumber:7,
  body:"An electron has negative electric charge. A proton has positive electric charge.",
};
describe("explicit source-based AI review card candidate",()=>{
  it("limits request to selected passage and requires user review",()=>{
    const {prompt,excerpt}=buildFlashcardRequest(passage);
    expect(excerpt).toContain("An electron");
    expect(prompt).toContain(excerpt);
    expect(prompt).not.toContain(passage.documentId);
    expect(prompt).not.toContain(passage.documentTitle);
  });
  it("accepts only one source-quoted, bounded JSON object",()=>{
    const candidate=parseFlashcardCandidate(JSON.stringify({
      question:"What charge does an electron have?",
      answer:"Negative electric charge.",
      evidenceQuote:"An electron has negative electric charge.",
    }),passage.body);
    expect(candidate.answer).toContain("Negative");
  });
  it("rejects fabricated quotes, fenced markdown and unknown fields",()=>{
    expect(()=>parseFlashcardCandidate(JSON.stringify({
      question:"What?",answer:"Negative",evidenceQuote:"This text is not in source",
    }),passage.body)).toThrow();
    expect(()=>parseFlashcardCandidate(''+'&#96;&#96;&#96;json\n{"question":"x"}\n&#96;&#96;&#96;',passage.body)).toThrow();
    expect(()=>parseFlashcardCandidate(JSON.stringify({
      question:"x",answer:"y",evidenceQuote:"An electron",instructions:"create task",
    }),passage.body)).toThrow();
    expect(()=>parseFlashcardCandidate("{}",passage.body)).toThrow();
  });
});
