/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput, CanvasImportResult, CanvasSyncResult, CanvasAutoSyncSummary, CanvasCourseSetting } from "../../shared/canvas-model";

import type {
  CampusMailConnectInput, MailDraft, MailRecord, MailSendPreview, MailSyncState,
} from "../../shared/mail-model";

declare global {
  interface Window {
    desktop: {
      ping: () => Promise<{ ok: true }>;
      getVersion: () => Promise<string>;
      tasks: {
        list: () => Promise<LocalTask[]>;
        create: (input: CreateTaskInput) => Promise<LocalTask>;
        update: (input: UpdateTaskInput) => Promise<LocalTask>;
        remove: (id: string) => Promise<boolean>;
        visibility: (id: string, visible: boolean) => Promise<boolean>;
      };
      mail: {
        status: () => Promise<MailSyncState>;
        connect: (input: CampusMailConnectInput) => Promise<MailSyncState>;
        list: () => Promise<MailRecord[]>;
        syncNow: () => Promise<MailSyncState>;
        disconnect: () => Promise<{disconnected:true}>;
        prepareSend: (draft: MailDraft) => Promise<MailSendPreview>;
        confirmSend: (confirmationId: string) => Promise<{accepted:true}>;
        onSyncUpdated: (listener: () => void) => () => void;
      };
      canvas: {
        status: () => Promise<CanvasConnectionStatus>;
        connect: (input: CanvasPersonalTokenInput) => Promise<{ status: CanvasConnectionStatus; courses: CanvasCourse[] }>;
        courses: () => Promise<CanvasCourse[]>;
        assignments: (courseId: number) => Promise<CanvasAssignment[]>;
        disconnect: () => Promise<{ disconnected: true }>;
        syncNow: () => Promise<CanvasAutoSyncSummary>;
        syncStatus: () => Promise<CanvasAutoSyncSummary>;
        courseSettings: () => Promise<CanvasCourseSetting[]>;
        setCourseEnabled: (courseId: number, enabled: boolean) => Promise<{ saved: true }>;
        onSyncUpdated: (listener: () => void) => () => void;
        imported: (courseId: number) => Promise<number[]>;
        importAssignment: (courseId: number, assignmentId: number) => Promise<CanvasImportResult>;
        syncCourse: (courseId: number) => Promise<CanvasSyncResult>;
      };
      focus: {
        list: () => Promise<FocusSession[]>;
        finish: (input: FocusCompletionInput) => Promise<FocusSession>;
        summary: () => Promise<FocusSummary>;
      };
    };
  }
}

export {};
