import { describe, expect, it } from "vitest";
import { parseCreateTask, parseFocusCompletion, parseUpdateTask } from "./local-model";

// Deliberately validate incoming untrusted renderer payloads in the shared layer.
const id = "d2270e99-fca1-496f-9327-76dcf25e092e";
describe("local task payload validation", () => {
  it("trims and defaults a create request", () => {
    expect(parseCreateTask({ title: "  学习  " })).toEqual({
      title: "学习", description: "", dueDate: null, priority: "normal",
    });
  });
  it("rejects invalid dates and unknown input fields", () => {
    expect(() => parseCreateTask({ title: "Task", dueDate: "2026-02-30" })).toThrow();
    expect(() => parseCreateTask({ title: "Task", sql: "DROP TABLE tasks" })).toThrow();
  });
  it("accepts completion updates and rejects empty changes", () => {
    expect(parseUpdateTask({ id, completed: true })).toEqual({ id, completed: true });
    expect(() => parseUpdateTask({ id })).toThrow();
    expect(() => parseUpdateTask({ id, completed: "true" })).toThrow();
  });
  it("validates focus duration bounds", () => {
    expect(parseFocusCompletion({ sessionId: id, plannedMinutes: 25, elapsedSeconds: 1500 }).elapsedSeconds).toBe(1500);
    expect(() => parseFocusCompletion({ sessionId: id, plannedMinutes: 25, elapsedSeconds: 1800 })).toThrow();
  });
});
