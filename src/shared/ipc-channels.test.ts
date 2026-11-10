import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC allowlist integration: mail and shared cloud", () => {
  it("exposes the exact reviewed channel list from both merged features", () => {
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
        "cloud:configure",
        "cloud:create-invite",
        "cloud:create-task",
        "cloud:create-workspace",
        "cloud:join-workspace",
        "cloud:login",
        "cloud:logout",
        "cloud:mark-task",
        "cloud:members",
        "cloud:messages",
        "cloud:send-message",
        "cloud:signup",
        "cloud:status",
        "cloud:tasks",
        "cloud:workspaces",
        "focus:finish",
        "focus:list",
        "focus:summary",
        "mail:candidates",
        "mail:confirm-send",
        "mail:connect",
        "mail:disconnect",
        "mail:list",
        "mail:prepare-send",
        "mail:review-candidate",
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

  it("preserves all mail and cloud handlers without overlap", () => {
    const all = Object.values(IPC_CHANNELS);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((name) => name.startsWith("mail:"))).toHaveLength(10);
    expect(all.filter((name) => name.startsWith("cloud:"))).toHaveLength(15);
  });

  it("does not expose arbitrary Node, SQL, filesystem or shell operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
