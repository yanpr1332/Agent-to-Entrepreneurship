import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC allowlist integration: mail and shared cloud", () => {
  it("exposes the exact reviewed channel list from both merged features", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual([
      "ai:cancel",
      "ai:confirm",
      "ai:connect",
      "ai:disconnect",
      "ai:plan-confirm",
      "ai:plan-prepare",
      "ai:prepare",
      "ai:status",
      "app:get-version",
      "app:ping",
      "backup:create",
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
      "knowledge:cards",
      "knowledge:create-card",
      "knowledge:delete",
      "knowledge:documents",
      "knowledge:graph",
      "knowledge:graph-create-edge",
      "knowledge:graph-create-node",
      "knowledge:graph-delete-edge",
      "knowledge:graph-delete-node",
      "knowledge:graph-edit-node",
      "knowledge:get",
      "knowledge:import",
      "knowledge:passage",
      "knowledge:remove-card",
      "knowledge:review-card",
      "knowledge:review-progress",
      "knowledge:search",
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
      "planning:apply",
      "planning:batches",
      "planning:blocks",
      "planning:generate",
      "planning:proposals",
      "planning:undo",
      "tasks:create",
      "tasks:list",
      "tasks:remove",
      "tasks:update",
      "tasks:visibility"
    ].sort());
  });

  it("preserves all mail and cloud handlers without overlap", () => {
    const all = Object.values(IPC_CHANNELS);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((name) => name.startsWith("mail:"))).toHaveLength(10);
    expect(all.filter((name) => name.startsWith("cloud:"))).toHaveLength(15);
  });

  it("permits only explicit AI status, configuration, approval, cancel and disconnect calls",()=>{
    expect(Object.values(IPC_CHANNELS).filter(x=>x.startsWith("ai:"))).toEqual([
      "ai:status","ai:connect","ai:disconnect","ai:prepare","ai:confirm","ai:cancel",
      "ai:plan-prepare","ai:plan-confirm",
    ]);
  });

  it("exposes only six explicit planning actions",()=>{
    expect(Object.values(IPC_CHANNELS).filter(x=>x.startsWith("planning:"))).toHaveLength(6);
  });

  it("keeps knowledge and backup operations narrowly allowlisted", () => {
    const channels=Object.values(IPC_CHANNELS);
    expect(channels.filter(name=>name.startsWith("knowledge:"))).toHaveLength(17);
    expect(channels.filter(name=>name.startsWith("backup:"))).toEqual(["backup:create"]);
  });

  it("does not expose arbitrary Node, SQL, filesystem or shell operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
