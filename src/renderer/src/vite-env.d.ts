/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput } from "../../shared/canvas-model";

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
      };
      canvas: {
        status: () => Promise<CanvasConnectionStatus>;
        connect: (input: CanvasPersonalTokenInput) => Promise<{ status: CanvasConnectionStatus; courses: CanvasCourse[] }>;
        courses: () => Promise<CanvasCourse[]>;
        assignments: (courseId: number) => Promise<CanvasAssignment[]>;
        disconnect: () => Promise<{ disconnected: true }>;
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
