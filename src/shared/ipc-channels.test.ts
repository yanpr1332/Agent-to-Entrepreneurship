import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC allowlist integration: mail and shared cloud", () => {
  it("exposes the exact reviewed channel list from both merged features", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual([
      "ai:cancel",
      "ai:confirm",
      "ai:connect",
      "ai:disconnect",
      "ai:plan-cancel",
      "ai:plan-confirm",
      "ai:plan-prepare",
      "ai:prepare",
      "ai:project-action-grants",
      "ai:project-archive",
      "ai:project-audit",
      "ai:project-create",
      "ai:project-rename",
      "ai:project-revoke-source-grant",
      "ai:project-set-action-grant",
      "ai:project-set-source-grant",
      "ai:project-source-grants",
      "ai:projects-list",
      "ai:status",
      "app:get-version",
      "app:ping",
      "backup:cancel",
      "backup:create",
      "backup:inspect",
      "backup:restore",
      "calendar:canvas-visibility",
      "calendar:fixed-create",
      "calendar:fixed-delete",
      "calendar:fixed-delete-series",
      "calendar:fixed-edit",
      "calendar:fixed-edit-series",
      "calendar:fixed-list",
      "calendar:ics-cancel",
      "calendar:ics-confirm",
      "calendar:ics-export",
      "calendar:ics-preview",
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
      "cloud:adopt-personal-sync-legacy",
      "cloud:confirm-personal-sync-device-replacement",
      "cloud:discard-personal-sync-receipt-review",
      "cloud:file-overview",
      "cloud:file-stage",
      "cloud:file-upload",
      "cloud:file-stop-local",
      "cloud:file-download",
      "cloud:file-delete",
      "cloud:inspect-personal-sync-recovery",
      "cloud:clear-team-history",
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
      "cloud:personal-sync-candidates",
      "cloud:personal-sync-conflicts",
      "cloud:personal-sync-legacy-review",
      "cloud:personal-sync-now",
      "cloud:revoke-member",
      "cloud:resolve-personal-sync-conflict",
      "cloud:review-personal-sync-device-replacement",
      "cloud:reconcile-personal-sync-receipts",
      "cloud:review-personal-sync-receipts",
      "cloud:send-message",
      "cloud:set-manual-event-sync",
      "cloud:set-personal-task-sync",
      "cloud:signup",
      "cloud:status",
      "cloud:tasks",
      "cloud:watch-workspace",
      "cloud:workspace-live-updated",
      "cloud:workspace-history-older",
      "cloud:workspace-snapshot",
      "cloud:stop-workspace-watch",
      "cloud:workspaces",
      "focus:finish",
      "focus:guard-start",
      "focus:guard-status",
      "focus:guard-stop",
      "focus:insights",
      "focus:reward-create",
      "focus:reward-edit",
      "focus:reward-redeem",
      "focus:rewards",
      "focus:list",
      "focus:rename",
      "focus:summary",
      "knowledge:cards",
      "knowledge:create-card",
      "knowledge:card-edit",
      "knowledge:card-rebind",
      "knowledge:card-history",
      "knowledge:batch-import",
      "knowledge:delete",
      "knowledge:embedding-status",
      "knowledge:embedding-import",
      "knowledge:embedding-import-neural","knowledge:neural-runtime-check","knowledge:embedding-start",
      "knowledge:embedding-cancel","knowledge:embedding-remove",
      "knowledge:embedding-evaluate",
      "knowledge:embedding-evidence-catalog",
      "knowledge:embedding-evidence-page",
      "knowledge:embedding-save-labels",
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
      "knowledge:source-audit",
      "knowledge:source-refresh",
      "mail:ai-apply",
      "mail:ai-cancel",
      "mail:ai-confirm",
      "mail:ai-prepare",
      "mail:candidates",
      "mail:confirm-send",
      "mail:read-body",
      "mail:saved-drafts",
      "mail:save-draft",
      "mail:delete-draft",
      "mail:connect",
      "mail:disconnect",
      "mail:list",
      "mail:prepare-send",
      "mail:review-candidate",
      "mail:status",
      "mail:sync-now",
      "mail:sync-updated",
      "planning:apply",
      "planning:block-remove",
      "planning:block-update",
      "planning:batches",
      "planning:blocks",
      "planning:generate",
      "planning:manual-create",
      "planning:proposals",
      "planning:undo",
      "tasks:create",
      "tasks:list",
      "tasks:remove",
      "tasks:update",
      "tasks:visibility"
    ].sort());
  });

  it("limits local calendar access to eleven explicitly reviewed methods",()=>{
    expect(Object.values(IPC_CHANNELS).filter(x=>x.startsWith("calendar:")).sort()).toEqual([
      "calendar:canvas-visibility","calendar:fixed-create","calendar:fixed-delete",
      "calendar:fixed-delete-series","calendar:fixed-edit","calendar:fixed-edit-series",
      "calendar:fixed-list","calendar:ics-cancel","calendar:ics-confirm",
      "calendar:ics-export","calendar:ics-preview",
    ].sort());
  });
  it("preserves all mail and cloud handlers without overlap", () => {
    const all = Object.values(IPC_CHANNELS);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((name) => name.startsWith("mail:"))).toHaveLength(18);
    expect(all.filter((name) => name.startsWith("cloud:"))).toHaveLength(42);
    expect(all.filter(name=>name.startsWith("cloud:file-"))).toHaveLength(6);
  });

  it("permits only explicit AI status, configuration, approval, cancel and disconnect calls",()=>{
    expect(Object.values(IPC_CHANNELS).filter(x=>x.startsWith("ai:"))).toEqual([
      "ai:status","ai:connect","ai:disconnect","ai:prepare","ai:confirm","ai:cancel",
      "ai:plan-prepare","ai:plan-confirm",
    ]);
  });

  it("exposes only the nine reviewed planning actions",()=>{
    expect(Object.values(IPC_CHANNELS).filter(x=>x.startsWith("planning:")).sort()).toEqual([
      "planning:apply","planning:batches","planning:block-remove","planning:block-update",
      "planning:blocks","planning:generate","planning:manual-create",
      "planning:proposals","planning:undo",
    ].sort());
  });

  it("keeps knowledge and backup operations narrowly allowlisted", () => {
    const channels=Object.values(IPC_CHANNELS);
    expect(channels.filter(name=>name.startsWith("knowledge:"))).toHaveLength(34);
    expect(channels.filter(name=>name.startsWith("backup:"))).toEqual([
      "backup:create","backup:inspect","backup:restore","backup:cancel",
    ]);
  });

  it("does not expose arbitrary Node, SQL, filesystem or shell operations", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
