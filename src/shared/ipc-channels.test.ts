import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./ipc-channels";

describe("IPC channel contract", () => {
  it("exposes only approved application channels", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual(["app:get-version", "app:ping"]);
  });
  it("does not expose arbitrary Node or shell capabilities", () => {
    expect(Object.values(IPC_CHANNELS).join(" ")).not.toMatch(/(exec|shell|filesystem|ipcRenderer)/i);
  });
});
