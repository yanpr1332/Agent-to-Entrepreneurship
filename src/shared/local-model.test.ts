import { describe, expect, it } from "vitest";
import { parseCreateTask, parseFocusCompletion, parseFocusTitleUpdate, parseUpdateTask } from "./local-model";

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
  it("validates actual focus wall-time bounds and title changes", () => {
    const bounds = {
      sessionId: id, plannedMinutes: 3, elapsedSeconds: 120,
      title: "  复习微积分  ", startedAt: "2026-11-19T06:00:00.000Z",
      endedAt: "2026-11-19T06:05:00.000Z",
    };
    expect(parseFocusCompletion(bounds)).toMatchObject({
      title: "复习微积分", startedAt: bounds.startedAt, endedAt: bounds.endedAt,
    });
    expect(() => parseFocusCompletion({...bounds, endedAt: undefined})).toThrow();
    expect(() => parseFocusCompletion({...bounds, endedAt: "2026-11-19T06:01:00.000Z"})).toThrow();
    expect(() => parseFocusCompletion({...bounds, title: "<".repeat(121)})).toThrow();
    expect(parseFocusTitleUpdate({id, title: "  修改标题  "})).toEqual({id, title:"修改标题"});
    expect(() => parseFocusTitleUpdate({id, title: "", points: 500})).toThrow();
  });

  it("validates focus duration bounds", () => {
    expect(parseFocusCompletion({ sessionId: id, plannedMinutes: 25, elapsedSeconds: 1500 }).elapsedSeconds).toBe(1500);
    expect(() => parseFocusCompletion({ sessionId: id, plannedMinutes: 25, elapsedSeconds: 1800 })).toThrow();
  });
});
