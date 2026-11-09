/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

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
      focus: {
        list: () => Promise<FocusSession[]>;
        finish: (input: FocusCompletionInput) => Promise<FocusSession>;
        summary: () => Promise<FocusSummary>;
      };
    };
  }
}

export {};
