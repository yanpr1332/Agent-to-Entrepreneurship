import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput } from "../shared/canvas-model";

const desktopApi = Object.freeze({
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.appPing) as Promise<{ ok: true }>,
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion) as Promise<string>,
  tasks: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.tasksList) as Promise<LocalTask[]>,
    create: (input: CreateTaskInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksCreate, input) as Promise<LocalTask>,
    update: (input: UpdateTaskInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksUpdate, input) as Promise<LocalTask>,
    remove: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksRemove, id) as Promise<boolean>,
  }),
  canvas: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.canvasStatus) as Promise<CanvasConnectionStatus>,
    connect: (input: CanvasPersonalTokenInput) => ipcRenderer.invoke(IPC_CHANNELS.canvasConnect, input) as Promise<{ status: CanvasConnectionStatus; courses: CanvasCourse[] }>,
    courses: () => ipcRenderer.invoke(IPC_CHANNELS.canvasCourses) as Promise<CanvasCourse[]>,
    assignments: (courseId: number) => ipcRenderer.invoke(IPC_CHANNELS.canvasAssignments, courseId) as Promise<CanvasAssignment[]>,
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.canvasDisconnect) as Promise<{ disconnected: true }>,
  }),
  focus: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.focusList) as Promise<FocusSession[]>,
    finish: (input: FocusCompletionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.focusFinish, input) as Promise<FocusSession>,
    summary: () => ipcRenderer.invoke(IPC_CHANNELS.focusSummary) as Promise<FocusSummary>,
  }),
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
