import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC channel contract", () => {
  it("exposes only the explicitly reviewed and narrow application channels", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual([
          "app:get-version",
          "app:ping",
          "canvas:assignments",
          "canvas:connect",
          "canvas:course-settings",
          "canvas:courses",
          "canvas:disconnect",
          "canvas:import-assignment",
          "canvas:imported",
          "canvas:set-course-enabled",
          "canvas:status",
          "canvas:sync-course",
          "canvas:sync-now",
          "canvas:sync-status",
          "canvas:sync-updated",
          "focus:finish",
          "focus:list",
          "focus:summary",
          "tasks:create",
          "tasks:list",
          "tasks:remove",
          "tasks:update",
          "tasks:visibility"
    ]);
  });
  it("does not expose arbitrary Node, filesystem or SQL operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
