import { describe, expect, it } from "vitest";
import {
  classifyMailSubject, parseMailCandidateChoice, suggestedTaskTitle,
} from "./mail-candidates";

describe("privacy-preserving mail subject candidate detection", () => {
  it("finds actionable academic hints but not every mail", () => {
    expect(classifyMailSubject("第三周作业安排")).toBe("coursework");
    expect(classifyMailSubject("Please submit before deadline")).toBe("deadline");
    expect(classifyMailSubject("学院会议报名")).toBe("event");
    expect(classifyMailSubject("欢迎注册邮箱")).toBeNull();
    expect(classifyMailSubject("大家周末好")).toBeNull();
  });

  it("never guesses an assignment due date from a sent timestamp", () => {
    expect(suggestedTaskTitle("  关于实验报告  ")).toBe("关于实验报告");
    expect(suggestedTaskTitle("a".repeat(600))).toHaveLength(120);
  });

  it("accepts only reviewed, positive integer UID identity and explicit decisions", () => {
    expect(parseMailCandidateChoice({uid:42,uidValidity:8,action:"accept"}))
      .toEqual({uid:42,uidValidity:8,action:"accept"});
    expect(() => parseMailCandidateChoice({uid:0,uidValidity:8,action:"ignore"})).toThrow();
    expect(() => parseMailCandidateChoice({uid:42,uidValidity:8,action:"send"})).toThrow();
    expect(() => parseMailCandidateChoice({uid:42,uidValidity:8,action:"accept",subject:"forged"})).toThrow();
  });
});
