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
  canvasStatus: "canvas:status",
  canvasConnect: "canvas:connect",
  canvasCourses: "canvas:courses",
  canvasAssignments: "canvas:assignments",
  canvasDisconnect: "canvas:disconnect",
  canvasImported: "canvas:imported",
  canvasImportAssignment: "canvas:import-assignment",
  canvasSyncCourse: "canvas:sync-course",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
