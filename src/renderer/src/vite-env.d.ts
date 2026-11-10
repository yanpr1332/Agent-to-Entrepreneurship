/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput, CanvasImportResult, CanvasSyncResult, CanvasAutoSyncSummary, CanvasCourseSetting } from "../../shared/canvas-model";

import type {
  CampusMailConnectInput, MailDraft, MailRecord, MailSendPreview, MailSyncState,
} from "../../shared/mail-model";
import type { MailCandidate, MailCandidateChoice, MailCandidateChoiceResult } from "../../shared/mail-candidates";

import type {
  CloudCredentials, CloudProjectConfig, CloudSessionStatus,
  SharedWorkspace, SharedMember, SharedMessage, SharedTask, SharedTaskInput,
} from "../../shared/cloud-model";

import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeReviewCard, ReviewCardInput, ReviewRating, ReviewProgress, BackupResult, KnowledgePassage,
} from "../../shared/knowledge-model";

import type {
  KnowledgeGraphSnapshot, GraphNode, GraphEdge, GraphNodeInput, GraphNodeEdit, GraphEdgeInput,
} from "../../shared/knowledge-graph-model";

import type { FixedEvent,CreateFixedEventInput,ICSPreview,ICSImportResult,ICSExportResult } from "../../shared/fixed-calendar-model";
import type {
  PlanningSettings, PlanProposal, PlanBlock, AppliedPlanBatch, ApplyPlanRequest,
} from "../../shared/planning-model";

import type {
  AIConnectInput, AIStatus, AIPreview, AIAnswer,
} from "../../shared/ai-model";

import type { AIPlanPrepareInput, AIPlanAccepted } from "../../shared/ai-plan-model";

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
        candidates: () => Promise<MailCandidate[]>;
        reviewCandidate: (choice: MailCandidateChoice) => Promise<MailCandidateChoiceResult>;
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
      ai: {
        status: () => Promise<AIStatus>;
        connect: (settings: AIConnectInput) => Promise<AIStatus>;
        disconnect: () => Promise<AIStatus>;
        prepare: (prompt: string) => Promise<AIPreview>;
        confirm: (approvalId: string) => Promise<AIAnswer>;
        cancel: () => Promise<AIStatus>;
        planPrepare: (selection: AIPlanPrepareInput) => Promise<AIPreview>;
        planConfirm: (approvalId: string) => Promise<AIPlanAccepted>;
      };
      calendar: {
        list:()=>Promise<FixedEvent[]>;
        create:(input:CreateFixedEventInput)=>Promise<FixedEvent[]>;
        remove:(id:string)=>Promise<boolean>;
        previewICS:()=>Promise<ICSPreview|null>;
        confirmICS:(id:string)=>Promise<ICSImportResult>;
        exportICS:()=>Promise<ICSExportResult>;
      };
      planning: {
        generate: (settings: PlanningSettings) => Promise<PlanProposal>;
        proposals: () => Promise<PlanProposal[]>;
        blocks: () => Promise<PlanBlock[]>;
        batches: () => Promise<AppliedPlanBatch[]>;
        apply: (selection: ApplyPlanRequest) => Promise<AppliedPlanBatch>;
        undo: (id: string) => Promise<boolean>;
      };
      knowledge: {
        graph: () => Promise<KnowledgeGraphSnapshot>;
        createNode: (input:GraphNodeInput) => Promise<GraphNode>;
        editNode: (input:GraphNodeEdit) => Promise<GraphNode>;
        deleteNode: (id:string) => Promise<boolean>;
        createEdge: (input:GraphEdgeInput) => Promise<GraphEdge>;
        deleteEdge: (id:string) => Promise<boolean>;
        documents: () => Promise<KnowledgeDocument[]>;
        get: (id: string) => Promise<KnowledgeSnapshot>;
        passage: (id: string, ordinal: number) => Promise<KnowledgePassage>;
        importFile: () => Promise<{document:KnowledgeDocument;changed:boolean}|null>;
        delete: (id: string) => Promise<boolean>;
        search: (query: string) => Promise<KnowledgeSearchHit[]>;
        cards: () => Promise<KnowledgeReviewCard[]>;
        createCard: (input: ReviewCardInput) => Promise<KnowledgeReviewCard>;
        removeCard: (id: string) => Promise<boolean>;
        reviewCard: (id: string, rating: ReviewRating) => Promise<KnowledgeReviewCard>;
        progress: () => Promise<ReviewProgress>;
      };
      backup: { create: () => Promise<BackupResult> };
      focus: {
        list: () => Promise<FocusSession[]>;
        finish: (input: FocusCompletionInput) => Promise<FocusSession>;
        summary: () => Promise<FocusSummary>;
      };
    };
  }
}

export {};
