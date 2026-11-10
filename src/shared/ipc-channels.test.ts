import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC allowlist contract", () => {
  it("exposes only reviewed explicit narrow channels", () => {
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
          "mail:confirm-send",
          "mail:connect",
          "mail:disconnect",
          "mail:list",
          "mail:prepare-send",
          "mail:status",
          "mail:sync-now",
          "mail:sync-updated",
          "tasks:create",
          "tasks:list",
          "tasks:remove",
          "tasks:update",
          "tasks:visibility"
    ]);
  });
  it("has no generic arbitrary Node, SQL, filesystem or shell operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
