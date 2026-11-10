import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput, CanvasImportResult, CanvasSyncResult, CanvasAutoSyncSummary, CanvasCourseSetting } from "../shared/canvas-model";

import type {
  CampusMailConnectInput, MailDraft, MailRecord, MailSendPreview, MailSyncState,
} from "../shared/mail-model";

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
    visibility: (id: string, visible: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksVisibility, { id, visible }) as Promise<boolean>,
  }),
  mail: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.mailStatus) as Promise<MailSyncState>,
    connect: (input: CampusMailConnectInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.mailConnect, input) as Promise<MailSyncState>,
    list: () => ipcRenderer.invoke(IPC_CHANNELS.mailList) as Promise<MailRecord[]>,
    syncNow: () => ipcRenderer.invoke(IPC_CHANNELS.mailSyncNow) as Promise<MailSyncState>,
    disconnect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.mailDisconnect) as Promise<{disconnected:true}>,
    prepareSend: (draft: MailDraft) =>
      ipcRenderer.invoke(IPC_CHANNELS.mailPrepareSend, draft) as Promise<MailSendPreview>,
    confirmSend: (confirmationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.mailConfirmSend, confirmationId) as Promise<{accepted:true}>,
    onSyncUpdated: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.mailSyncUpdated, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailSyncUpdated, handler);
    },
  }),
  canvas: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.canvasStatus) as Promise<CanvasConnectionStatus>,
    connect: (input: CanvasPersonalTokenInput) => ipcRenderer.invoke(IPC_CHANNELS.canvasConnect, input) as Promise<{ status: CanvasConnectionStatus; courses: CanvasCourse[] }>,
    courses: () => ipcRenderer.invoke(IPC_CHANNELS.canvasCourses) as Promise<CanvasCourse[]>,
    assignments: (courseId: number) => ipcRenderer.invoke(IPC_CHANNELS.canvasAssignments, courseId) as Promise<CanvasAssignment[]>,
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.canvasDisconnect) as Promise<{ disconnected: true }>,
    syncNow: () => ipcRenderer.invoke(IPC_CHANNELS.canvasSyncNow) as Promise<CanvasAutoSyncSummary>,
    syncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.canvasSyncStatus) as Promise<CanvasAutoSyncSummary>,
    courseSettings: () => ipcRenderer.invoke(IPC_CHANNELS.canvasCourseSettings) as Promise<CanvasCourseSetting[]>,
    setCourseEnabled: (courseId: number, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.canvasSetCourseEnabled, {courseId, enabled}) as Promise<{saved: true}>,
    onSyncUpdated: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.canvasSyncUpdated, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.canvasSyncUpdated, handler);
    },
    imported: (courseId: number) => ipcRenderer.invoke(IPC_CHANNELS.canvasImported, courseId) as Promise<number[]>,
    importAssignment: (courseId: number, assignmentId: number) => ipcRenderer.invoke(IPC_CHANNELS.canvasImportAssignment, courseId, assignmentId) as Promise<CanvasImportResult>,
    syncCourse: (courseId: number) => ipcRenderer.invoke(IPC_CHANNELS.canvasSyncCourse, courseId) as Promise<CanvasSyncResult>,
  }),
  focus: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.focusList) as Promise<FocusSession[]>,
    finish: (input: FocusCompletionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.focusFinish, input) as Promise<FocusSession>,
    summary: () => ipcRenderer.invoke(IPC_CHANNELS.focusSummary) as Promise<FocusSummary>,
  }),
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
