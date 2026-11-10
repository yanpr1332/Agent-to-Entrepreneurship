/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput, CanvasImportResult, CanvasSyncResult, CanvasAutoSyncSummary, CanvasCourseSetting } from "../../shared/canvas-model";

import type {
  CampusMailConnectInput, MailDraft, MailRecord, MailSendPreview, MailSyncState,
} from "../../shared/mail-model";

import type {
  CloudCredentials, CloudProjectConfig, CloudSessionStatus,
  SharedWorkspace, SharedMember, SharedMessage, SharedTask, SharedTaskInput,
} from "../../shared/cloud-model";

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
      cloud: {
        status: () => Promise<CloudSessionStatus>;
        configure: (input: CloudProjectConfig) => Promise<CloudSessionStatus>;
        login: (input: CloudCredentials) => Promise<CloudSessionStatus>;
        signup: (input: CloudCredentials) => Promise<{emailVerificationRequired:true}>;
        logout: () => Promise<CloudSessionStatus>;
        workspaces: () => Promise<SharedWorkspace[]>;
        createWorkspace: (name: string, displayName: string) => Promise<string>;
        createInvite: (workspaceId: string) => Promise<string>;
        joinWorkspace: (token: string, displayName: string) => Promise<string>;
        members: (workspaceId: string) => Promise<SharedMember[]>;
        messages: (workspaceId: string) => Promise<SharedMessage[]>;
        sendMessage: (workspaceId: string, body: string) => Promise<SharedMessage>;
        tasks: (workspaceId: string) => Promise<SharedTask[]>;
        createTask: (workspaceId: string, input: SharedTaskInput) => Promise<SharedTask>;
        markTask: (workspaceId: string, taskId: string, completed: boolean) => Promise<SharedTask>;
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
