import { describe, expect, it } from "vitest";
import { normalizeAddress, parseCampusMailCredentials, parseMailDraft } from "./mail-model";

describe("campus mail input boundaries", () => {
  it("validates campus identity without exposing secrets", () => {
    expect(parseCampusMailCredentials({
      email: "Student@sjtu.edu.cn", username: "student", password: "secret-code",
    })).toEqual({email: "student@sjtu.edu.cn", username: "student", password: "secret-code"});
    expect(() => parseCampusMailCredentials({
      email: "student@example.com", username: "student", password: "secret",
    })).toThrow("SJTU");
  });

  it("blocks header injection and recipient abuse", () => {
    expect(normalizeAddress("person@example.com")).toBe("person@example.com");
    expect(() => normalizeAddress("hello@example.com\r\nBcc: attacker@example.org")).toThrow();
    expect(() => parseMailDraft({
      to:["ok@example.com"], subject:"Hello\r\nBcc: evil@example.com", body:"Text",
    })).toThrow();
    expect(() => parseMailDraft({
      to: ["a@example.com","a@example.com"], subject:"Hi", body:"Text",
    })).toThrow("Duplicate");
  });

  it("validates a bounded confirmed-send draft", () => {
    expect(parseMailDraft({to:["a@example.com"],subject:" Hi ",body:"Hello"}))
      .toEqual({to:["a@example.com"],subject:"Hi",body:"Hello"});
    expect(() => parseMailDraft({to:[],subject:"Hi",body:"Hello"})).toThrow();
    expect(() => parseMailDraft({to:["a@example.com"],subject:"Hi",body:""})).toThrow();
  });
});
