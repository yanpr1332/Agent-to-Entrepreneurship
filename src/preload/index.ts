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
import type { MailCandidate, MailCandidateChoice, MailCandidateChoiceResult } from "../shared/mail-candidates";

import type {
  CloudCredentials, CloudProjectConfig, CloudSessionStatus,
  SharedWorkspace, SharedMember, SharedMessage, SharedTask, SharedTaskInput,
} from "../shared/cloud-model";

import type {
  KnowledgeDocument, KnowledgeSnapshot, KnowledgeSearchHit,
  KnowledgeReviewCard, ReviewCardInput, ReviewRating, ReviewProgress, BackupResult, KnowledgePassage,
} from "../shared/knowledge-model";

import type {
  KnowledgeGraphSnapshot, GraphNode, GraphEdge, GraphNodeInput, GraphNodeEdit, GraphEdgeInput,
} from "../shared/knowledge-graph-model";

import type {CalendarDisplayEvent} from "../shared/canvas-calendar-model";
import type { FixedEvent,CreateFixedEventInput,EditFixedEventInput,ICSPreview,ICSImportResult,ICSExportResult } from "../shared/fixed-calendar-model";
import type {
  PlanningSettings, PlanProposal, PlanBlock, AppliedPlanBatch, ApplyPlanRequest,
} from "../shared/planning-model";

import type {
  AIConnectInput, AIStatus, AIPreview, AIAnswer,
} from "../shared/ai-model";

import type { AIPlanPrepareInput, AIPlanAccepted } from "../shared/ai-plan-model";

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
    candidates: () => ipcRenderer.invoke(IPC_CHANNELS.mailCandidates) as Promise<MailCandidate[]>,
    reviewCandidate: (choice: MailCandidateChoice) =>
      ipcRenderer.invoke(IPC_CHANNELS.mailReviewCandidate, choice) as Promise<MailCandidateChoiceResult>,
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
  cloud: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.cloudStatus) as Promise<CloudSessionStatus>,
    configure: (input: CloudProjectConfig) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudConfigure, input) as Promise<CloudSessionStatus>,
    login: (input: CloudCredentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudLogin, input) as Promise<CloudSessionStatus>,
    signup: (input: CloudCredentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudSignup, input) as Promise<{emailVerificationRequired:true}>,
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.cloudLogout) as Promise<CloudSessionStatus>,
    workspaces: () => ipcRenderer.invoke(IPC_CHANNELS.cloudWorkspaces) as Promise<SharedWorkspace[]>,
    createWorkspace: (name: string, displayName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudCreateWorkspace, name, displayName) as Promise<string>,
    createInvite: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudCreateInvite, workspaceId) as Promise<string>,
    joinWorkspace: (token: string, displayName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudJoinWorkspace, token, displayName) as Promise<string>,
    members: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudMembers, workspaceId) as Promise<SharedMember[]>,
    messages: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudMessages, workspaceId) as Promise<SharedMessage[]>,
    sendMessage: (workspaceId: string, body: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudSendMessage, workspaceId, body) as Promise<SharedMessage>,
    tasks: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudTasks, workspaceId) as Promise<SharedTask[]>,
    createTask: (workspaceId: string, input: SharedTaskInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudCreateTask, workspaceId, input) as Promise<SharedTask>,
    markTask: (workspaceId: string, taskId: string, completed: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudMarkTask, workspaceId, taskId, completed) as Promise<SharedTask>,
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
  ai: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.aiStatus) as Promise<AIStatus>,
    connect: (settings: AIConnectInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiConnect,settings) as Promise<AIStatus>,
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.aiDisconnect) as Promise<AIStatus>,
    prepare: (prompt: string) => ipcRenderer.invoke(IPC_CHANNELS.aiPrepare,prompt) as Promise<AIPreview>,
    confirm: (approvalId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiConfirm,approvalId) as Promise<AIAnswer>,
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.aiCancel) as Promise<AIStatus>,
    planPrepare: (selection: AIPlanPrepareInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiPlanPrepare,selection) as Promise<AIPreview>,
    planConfirm: (approvalId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiPlanConfirm,approvalId) as Promise<AIPlanAccepted>,
  }),
  calendar: Object.freeze({
    list:()=>ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarList) as Promise<CalendarDisplayEvent[]>,
    setCanvasVisibility:(input:{id:string;visible:boolean})=>
      ipcRenderer.invoke(IPC_CHANNELS.canvasCalendarVisibility,input) as Promise<boolean>,
    create:(input:CreateFixedEventInput)=>
      ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarCreate,input) as Promise<FixedEvent[]>,
    remove:(id:string)=>
      ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarDelete,id) as Promise<boolean>,
    edit:(input:EditFixedEventInput)=>
      ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarEdit,input) as Promise<FixedEvent>,
    removeSeries:(id:string)=>
      ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarDeleteSeries,id) as Promise<number>,
    previewICS:()=>ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarPreviewICS) as Promise<ICSPreview|null>,
    confirmICS:(id:string)=>ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarConfirmICS,id) as Promise<ICSImportResult>,
    cancelICS:(id:string)=>ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarCancelICS,id) as Promise<{canceled:true}>,
    exportICS:()=>ipcRenderer.invoke(IPC_CHANNELS.fixedCalendarExportICS) as Promise<ICSExportResult>,
  }),
  planning: Object.freeze({
    generate: (settings: PlanningSettings) =>
      ipcRenderer.invoke(IPC_CHANNELS.planningGenerate,settings) as Promise<PlanProposal>,
    proposals: () => ipcRenderer.invoke(IPC_CHANNELS.planningProposals) as Promise<PlanProposal[]>,
    blocks: () => ipcRenderer.invoke(IPC_CHANNELS.planningBlocks) as Promise<PlanBlock[]>,
    batches: () => ipcRenderer.invoke(IPC_CHANNELS.planningBatches) as Promise<AppliedPlanBatch[]>,
    apply: (selection: ApplyPlanRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.planningApply,selection) as Promise<AppliedPlanBatch>,
    undo: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.planningUndo,id) as Promise<boolean>,
  }),
  knowledge: Object.freeze({
    graph: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraph) as Promise<KnowledgeGraphSnapshot>,
    createNode: (input:GraphNodeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraphCreateNode,input) as Promise<GraphNode>,
    editNode: (input:GraphNodeEdit) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraphEditNode,input) as Promise<GraphNode>,
    deleteNode: (id:string) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraphDeleteNode,id) as Promise<boolean>,
    createEdge: (input:GraphEdgeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraphCreateEdge,input) as Promise<GraphEdge>,
    deleteEdge: (id:string) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeGraphDeleteEdge,id) as Promise<boolean>,
    documents: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeDocuments) as Promise<KnowledgeDocument[]>,
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGet,id) as Promise<KnowledgeSnapshot>,
    passage: (id: string, ordinal: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgePassage,id,ordinal) as Promise<KnowledgePassage>,
    importFile: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeImport) as Promise<{document:KnowledgeDocument;changed:boolean}|null>,
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeDelete,id) as Promise<boolean>,
    search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSearch,query) as Promise<KnowledgeSearchHit[]>,
    cards: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeCards) as Promise<KnowledgeReviewCard[]>,
    createCard: (input: ReviewCardInput) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeCreateCard,input) as Promise<KnowledgeReviewCard>,
    removeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeRemoveCard,id) as Promise<boolean>,
    reviewCard: (id: string, rating: ReviewRating) =>
      ipcRenderer.invoke(IPC_CHANNELS.knowledgeReviewCard,id,rating) as Promise<KnowledgeReviewCard>,
    progress: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeReviewProgress) as Promise<ReviewProgress>,
  }),
  backup: Object.freeze({
    create: () => ipcRenderer.invoke(IPC_CHANNELS.backupCreate) as Promise<BackupResult>,
  }),
  focus: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.focusList) as Promise<FocusSession[]>,
    finish: (input: FocusCompletionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.focusFinish, input) as Promise<FocusSession>,
    summary: () => ipcRenderer.invoke(IPC_CHANNELS.focusSummary) as Promise<FocusSummary>,
  }),
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
