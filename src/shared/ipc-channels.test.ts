import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC channel contract", () => {
  it("exposes only the approved narrow application actions", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual([
      "app:get-version", "app:ping", "canvas:assignments", "canvas:connect",
      "canvas:courses", "canvas:disconnect", "canvas:status", "focus:finish", "focus:list",
      "focus:summary", "tasks:create", "tasks:list", "tasks:remove",
      "tasks:update",
    ]);
  });
  it("does not expose arbitrary Node, filesystem or SQL operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
