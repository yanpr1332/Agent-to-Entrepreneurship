import { describe,expect,it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("approved IPC allowlist",()=>{
  it("exposes only narrow reviewed calls",()=>{
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
          "tasks:create",
          "tasks:list",
          "tasks:remove",
          "tasks:update",
          "tasks:visibility"
    ]);
  });
  it("does not expose generic database, filesystem or shell APIs",()=>{
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|sql|ipcRenderer)/i);
  });
});
