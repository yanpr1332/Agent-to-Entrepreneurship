/** Exact allowlist for renderer-to-main requests. */
export const IPC_CHANNELS = {
  appPing: "app:ping",
  appGetVersion: "app:get-version",
  tasksList: "tasks:list",
  tasksCreate: "tasks:create",
  tasksUpdate: "tasks:update",
  tasksRemove: "tasks:remove",
  focusList: "focus:list",
  focusFinish: "focus:finish",
  focusSummary: "focus:summary",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
