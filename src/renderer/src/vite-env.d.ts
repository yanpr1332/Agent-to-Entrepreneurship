/// <reference types="vite/client" />

import type {
  CreateTaskInput, FocusCompletionInput, FocusSession, FocusSummary, FocusInsights, FocusTitleUpdate,
  LocalTask, UpdateTaskInput,
} from "../../shared/local-model";

import type { CanvasAssignment, CanvasConnectionStatus, CanvasCourse, CanvasPersonalTokenInput, CanvasImportResult, CanvasSyncResult, CanvasAutoSyncSummary, CanvasCourseSetting } from "../../shared/canvas-model";

import type {
  CampusMailConnectInput, MailDraft, MailRecord, MailSendPreview, MailSyncState,
} from "../../shared/mail-model";
import type { MailCandidate, MailCandidateChoice, MailCandidateChoiceResult } from "../../shared/mail-candidates";

import type {WorkspaceHistoryItems,WorkspaceHistoryMarker} from "../../shared/workspace-history-contract";
import type {
  CloudCredentials, CloudProjectConfig, CloudSessionStatus,
  SharedWorkspace, SharedMember, SharedMessage, SharedTask, SharedTaskInput,
  SharedWorkspaceSnapshot, WorkspaceLiveUpdate,
} from "../../shared/cloud-model";
import type {
  PersonalSyncCandidate, PersonalSyncConflictRecord, PersonalSyncRunResult,
  PersonalSyncResolutionRequest, PersonalSyncLegacyReview, PersonalSyncLegacyAdoptionRequest,
  PersonalSyncDeviceReplacementReview, PersonalSyncDeviceReplacementRequest,
  PersonalSyncRecoveryHealth, PersonalSyncReceiptReconcileResult,
  PersonalSyncReceiptReview, PersonalSyncReceiptConfirmation,
} from "../../shared/personal-sync-contract";

import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeBatchImportResult, KnowledgeSourceAuditEntry,
  KnowledgeSourceRefreshRequest, KnowledgeSourceRefreshResult,
  KnowledgeReviewCard, ReviewCardInput, ReviewCardEditInput, ReviewCardRebindInput,
  ReviewCardEvidenceHistory, ReviewRating, ReviewProgress, BackupResult, KnowledgePassage, KnowledgeEmbeddingStatus, KnowledgeEvaluationReport, KnowledgeEvidenceExportResult, KnowledgeEvidenceCatalogPage, KnowledgeLocalLabels, KnowledgeLabelsSaveResult,
} from "../../shared/knowledge-model";

import type {
  KnowledgeGraphSnapshot, GraphNode, GraphEdge, GraphNodeInput, GraphNodeEdit, GraphEdgeInput,
} from "../../shared/knowledge-graph-model";

import type {CalendarDisplayEvent} from "../../shared/canvas-calendar-model";
import type { FixedEvent,CreateFixedEventInput,EditFixedEventInput,EditFixedSeriesInput,ICSPreview,ICSImportResult,ICSExportResult } from "../../shared/fixed-calendar-model";
import type {
  PlanningSettings, PlanProposal, PlanBlock, AppliedPlanBatch, ApplyPlanRequest,
  ManualBlockInput, CommittedBlockEditInput,
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
        clearTeamHistory: (confirmation:"ERASE_CURRENT_TEAM_CACHE") => Promise<{workspaces:number;checkpointed:boolean}>;
        workspaces: () => Promise<SharedWorkspace[]>;
        createWorkspace: (name: string, displayName: string) => Promise<string>;
        createInvite: (workspaceId: string) => Promise<string>;
        joinWorkspace: (token: string, displayName: string) => Promise<string>;
        members: (workspaceId: string) => Promise<SharedMember[]>;
        messages: (workspaceId: string) => Promise<SharedMessage[]>;
        sendMessage: (workspaceId: string, body: string) => Promise<SharedMessage>;
        workspaceSnapshot: (workspaceId:string) => Promise<SharedWorkspaceSnapshot>;
        workspaceHistoryOlder: (workspaceId:string,kind:"message"|"task",before:WorkspaceHistoryMarker|null) => Promise<WorkspaceHistoryItems<SharedMessage|SharedTask>>;
        watchWorkspace: (workspaceId:string) => Promise<WorkspaceLiveUpdate>;
        stopWorkspaceWatch: (workspaceId:string) => Promise<{stopped:true}>;
        onWorkspaceLiveUpdated: (listener:(state:WorkspaceLiveUpdate)=>void) => () => void;
        tasks: (workspaceId: string) => Promise<SharedTask[]>;
        createTask: (workspaceId: string, input: SharedTaskInput) => Promise<SharedTask>;
        markTask: (workspaceId: string, taskId: string, completed: boolean) => Promise<SharedTask>;
        syncPersonalNow: () => Promise<PersonalSyncRunResult>;
        personalSyncCandidates: () => Promise<PersonalSyncCandidate[]>;
        setPersonalTaskSync: (id:string,enabled:boolean) => Promise<{saved:true}>;
        setManualEventSync: (id:string,enabled:boolean) => Promise<{saved:true}>;
        personalSyncConflicts: () => Promise<PersonalSyncConflictRecord[]>;
        inspectPersonalSyncRecovery: () => Promise<PersonalSyncRecoveryHealth>;
        reviewPersonalSyncReceipts: () => Promise<PersonalSyncReceiptReview>;
        discardPersonalSyncReceiptReview: () => Promise<{cancelled:true}>;
        reconcilePersonalSyncReceipts: (input:PersonalSyncReceiptConfirmation) => Promise<PersonalSyncReceiptReconcileResult>;
        reviewPersonalSyncDeviceReplacement: () => Promise<PersonalSyncDeviceReplacementReview>;
        confirmPersonalSyncDeviceReplacement: (input:PersonalSyncDeviceReplacementRequest) => Promise<{replaced:true}>;
        personalSyncLegacyReview:() => Promise<PersonalSyncLegacyReview>;
        adoptPersonalSyncLegacy:(input:PersonalSyncLegacyAdoptionRequest) => Promise<{saved:true}>;
        resolvePersonalSyncConflict:(input:PersonalSyncResolutionRequest) =>
          Promise<{resolved:true;choice:"keep-local"|"use-remote"}>;
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
        list:()=>Promise<CalendarDisplayEvent[]>;
        setCanvasVisibility:(input:{id:string;visible:boolean})=>Promise<boolean>;
        create:(input:CreateFixedEventInput)=>Promise<FixedEvent[]>;
        remove:(id:string)=>Promise<boolean>;
        edit:(input:EditFixedEventInput)=>Promise<FixedEvent>;
        removeSeries:(id:string)=>Promise<number>;
        editSeries:(input:EditFixedSeriesInput)=>Promise<FixedEvent[]>;
        previewICS:()=>Promise<ICSPreview|null>;
        confirmICS:(id:string)=>Promise<ICSImportResult>;
        cancelICS:(id:string)=>Promise<{canceled:true}>;
        exportICS:()=>Promise<ICSExportResult>;
      };
      planning: {
        generate: (settings: PlanningSettings) => Promise<PlanProposal>;
        proposals: () => Promise<PlanProposal[]>;
        blocks: () => Promise<PlanBlock[]>;
        batches: () => Promise<AppliedPlanBatch[]>;
        apply: (selection: ApplyPlanRequest) => Promise<AppliedPlanBatch>;
        undo: (id: string) => Promise<boolean>;
        manualCreate: (input: ManualBlockInput) => Promise<PlanBlock>;
        editBlock: (input: CommittedBlockEditInput) => Promise<PlanBlock>;
        removeBlock: (id: string) => Promise<boolean>;
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
        importBatch: () => Promise<KnowledgeBatchImportResult|null>;
        auditSources: (ids:string[]) => Promise<KnowledgeSourceAuditEntry[]>;
        refreshSources: (consent:boolean,items:KnowledgeSourceRefreshRequest[]) => Promise<KnowledgeSourceRefreshResult>;
        delete: (id: string) => Promise<boolean>;
        search: (query: string) => Promise<KnowledgeSearchHit[]>;
        embeddingStatus: () => Promise<KnowledgeEmbeddingStatus>;
        importOfflineModel: (acknowledged:boolean) => Promise<KnowledgeEmbeddingStatus|null>;
        startOfflineIndex: () => Promise<KnowledgeEmbeddingStatus>;
        cancelOfflineIndex: () => Promise<KnowledgeEmbeddingStatus>;
        removeOfflineModel: (confirmation:"REMOVE_LOCAL_MODEL_AND_VECTORS") => Promise<KnowledgeEmbeddingStatus>;
        evaluateOfflineModel: (consent:boolean) => Promise<KnowledgeEvaluationReport|null>;
        exportEvidenceCatalog: (consent:boolean) => Promise<KnowledgeEvidenceExportResult|null>;
        evidencePage: (offset:number) => Promise<KnowledgeEvidenceCatalogPage>;
        saveEvaluationLabels: (consent:boolean,labels:KnowledgeLocalLabels) => Promise<KnowledgeLabelsSaveResult|null>;
        cards: () => Promise<KnowledgeReviewCard[]>;
        createCard: (input: ReviewCardInput) => Promise<KnowledgeReviewCard>;
        editCard: (input:ReviewCardEditInput) => Promise<KnowledgeReviewCard>;
        rebindCard: (input:ReviewCardRebindInput) => Promise<KnowledgeReviewCard>;
        cardEvidenceHistory: (id:string) => Promise<ReviewCardEvidenceHistory[]>;
        removeCard: (id: string) => Promise<boolean>;
        reviewCard: (id: string, rating: ReviewRating) => Promise<KnowledgeReviewCard>;
        progress: () => Promise<ReviewProgress>;
      };
      backup: { create: () => Promise<BackupResult> };
      focus: {
        list: () => Promise<FocusSession[]>;
        finish: (input: FocusCompletionInput) => Promise<FocusSession>;
        rename: (input: FocusTitleUpdate) => Promise<FocusSession>;
        summary: () => Promise<FocusSummary>;
        insights: (timeZone:string) => Promise<FocusInsights>;
      };
    };
  }
}

export {};
