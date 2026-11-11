import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from "electron";
import { join,basename,extname } from "node:path";
import { randomUUID } from "node:crypto";
import { lstat,readFile,writeFile } from "node:fs/promises";
import { FixedCalendarStore } from "./fixed-calendar-store";
import { parseICS,exportICS } from "../shared/ics-calendar";
import type { ICSPreview,FixedEventDraft } from "../shared/fixed-calendar-model";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isTrustedRendererUrl } from "../shared/renderer-trust";
import { LocalStore } from "./local-store";
import { CanvasApi } from "./connectors/canvas-api";
import { CanvasCredentialVault } from "./connectors/canvas-credentials";
import { CanvasSyncService } from "./connectors/canvas-sync";
import { SharedCloudClient } from "./cloud/supabase-client";
import { parseCanvasCourseId, parseCanvasPersonalTokenInput } from "../shared/canvas-model";
import { CampusMailStore } from "./connectors/mail-store";
import { CampusMailVault } from "./connectors/mail-vault";
import { CampusMailService } from "./connectors/mail-service";
import { classifyMailSubject, parseMailCandidateChoice } from "../shared/mail-candidates";
import type { MailCandidate } from "../shared/mail-candidates";
import { KnowledgeStore } from "./knowledge-store";
import { PlanningStore } from "./planning-store";
import { readSelectedKnowledgeFile } from "./knowledge-import";
import { createLocalBackup, backupBeforeMigration } from "./local-backup";
import { AIKeyVault } from "./ai/ai-vault";
import { AIUsageLedger } from "./ai/ai-usage";
import { AIService } from "./ai/ai-service";
import { AIPlanningCoordinator } from "./ai/ai-planner";

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let knowledgeStore: KnowledgeStore | null = null;
let planningStore: PlanningStore | null = null;
let fixedCalendarStore: FixedCalendarStore | null = null;
let pendingICS:{id:string;expires:number;filename:string;events:FixedEventDraft[]}|null=null;
function fixedCalendar():FixedCalendarStore{
  if(!fixedCalendarStore)throw new Error("Fixed calendar database is unavailable");
  return fixedCalendarStore;
}
let aiService: AIService | null = null;
let aiPlanning: AIPlanningCoordinator | null = null;
function aiPlanner():AIPlanningCoordinator{
  if(!aiPlanning)throw new Error("AI planning is not initialized");
  return aiPlanning;
}
let aiLedger: AIUsageLedger | null = null;
function assistant():AIService {
  if(!aiService)throw new Error("AI provider is not initialized");
  return aiService;
}
function planner():PlanningStore{
  if(!planningStore)throw new Error("Planning database is unavailable");
  return planningStore;
}

function knowledge(): KnowledgeStore {
  if(!knowledgeStore)throw new Error("Local knowledge database is unavailable");
  return knowledgeStore;
}
let canvasVault: CanvasCredentialVault | null = null;
let canvasSync: CanvasSyncService | null = null;
let mailStore: CampusMailStore | null = null;
let mailService: CampusMailService | null = null;
const MAIL_SYNC_UPDATED = "mail:sync-updated";

function campusMail(): CampusMailService {
  if (!mailService) throw new Error("Campus email is not initialized");
  return mailService;
}
const CANVAS_SYNC_UPDATED = "canvas:sync-updated";
const sharedCloud = new SharedCloudClient();

function coordinator(): CanvasSyncService {
  if (!canvasSync) throw new Error("Canvas synchronization is not initialized");
  return canvasSync;
}

function credentials(): CanvasCredentialVault {
  if (!canvasVault) throw new Error("Canvas credentials are unavailable");
  return canvasVault;
}

async function canvasApi(): Promise<CanvasApi> {
  const stored = await credentials().load();
  if (!stored) throw new Error("Connect your personal Canvas account first");
  return new CanvasApi(stored.baseUrl, stored.token);
}

function isTrustedSender(candidate: string): boolean {
  const expectedFileUrl = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  return isTrustedRendererUrl(candidate, expectedFileUrl, process.env.ELECTRON_RENDERER_URL);
}

function requireTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event.senderFrame?.url ?? "")) {
    throw new Error("Untrusted IPC sender");
  }
}

function localStore(): LocalStore {
  if (!store) throw new Error("Local storage is not available");
  return store;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.appPing, (event) => {
    requireTrustedSender(event);
    return { ok: true as const };
  });
  ipcMain.handle(IPC_CHANNELS.appGetVersion, (event) => {
    requireTrustedSender(event);
    return app.getVersion();
  });
  ipcMain.handle(IPC_CHANNELS.tasksList, (event) => {
    requireTrustedSender(event);
    return localStore().listTasks();
  });
  ipcMain.handle(IPC_CHANNELS.tasksCreate, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().createTask(input);
  });
  ipcMain.handle(IPC_CHANNELS.tasksUpdate, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().updateTask(input);
  });
  ipcMain.handle(IPC_CHANNELS.tasksRemove, (event, id: unknown) => {
    requireTrustedSender(event);
    return localStore().removeTask(id);
  });
  ipcMain.handle(IPC_CHANNELS.tasksVisibility, (event, input: unknown) => {
    requireTrustedSender(event);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid task visibility request");
    }
    const data = input as Record<string, unknown>;
    if (Object.keys(data).sort().join(",") !== "id,visible" ||
        typeof data.visible !== "boolean") {
      throw new Error("Invalid task visibility request");
    }
    return localStore().setCanvasTaskVisibility(data.id, data.visible);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarList,event=>{
    requireTrustedSender(event);
    return fixedCalendar().list();
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarCreate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().create(input);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarDelete,(event,id:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().delete(id);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarEdit,(event,input:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().edit(input);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarDeleteSeries,(event,id:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().deleteSeries(id);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarPreviewICS,async event=>{
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Calendar import requires a trusted window");
    pendingICS=null;
    const chosen=await dialog.showOpenDialog(owner,{
      title:"选择本机 ICS 日历",
      properties:["openFile"],filters:[{name:"iCalendar",extensions:["ics"]}],
    });
    if(chosen.canceled||chosen.filePaths.length!==1)return null;
    const path=chosen.filePaths[0];
    if(extname(path).toLowerCase()!==".ics")throw Error("Only .ics files can be imported");
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024)
      throw Error("ICS import requires a regular file of at most 512 KiB");
    const buffer=await readFile(path);
    if(buffer.byteLength>512*1024)throw Error("ICS file grew beyond the import limit");
    const content=new TextDecoder("utf-8",{fatal:true}).decode(buffer);
    const events=parseICS(content);
    const id=randomUUID(),expires=Date.now()+120_000,filename=basename(path);
    pendingICS={id,expires,filename,events};
    return {approvalId:id,expiresAt:new Date(expires).toISOString(),
      filename,events} satisfies ICSPreview;
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarCancelICS,(event,id:unknown)=>{
    requireTrustedSender(event);
    if(pendingICS && id===pendingICS.id)pendingICS=null;
    return {canceled:true};
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarConfirmICS,(event,id:unknown)=>{
    requireTrustedSender(event);
    const pending=pendingICS;
    pendingICS=null; // Confirmation is one-use, even on error.
    if(!pending||id!==pending.id||Date.now()>pending.expires)
      throw Error("ICS preview expired; select and review the file again");
    return fixedCalendar().import(pending.events);
  });
  ipcMain.handle(IPC_CHANNELS.fixedCalendarExportICS,async event=>{
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Calendar export requires a trusted window");
    const events=fixedCalendar().list();
    const selection=await dialog.showSaveDialog(owner,{
      title:"导出本机日历（仅固定事件，不含个人任务）",
      defaultPath:"ate-calendar.ics",
      filters:[{name:"iCalendar",extensions:["ics"]}],
    });
    if(selection.canceled||!selection.filePath)return {saved:false,eventCount:0};
    if(extname(selection.filePath).toLowerCase()!==".ics")
      throw Error("Export destination must end in .ics");
    // Never overwrite an existing file or follow an existing symlink.
    await writeFile(selection.filePath,exportICS(events),{encoding:"utf8",flag:"wx",mode:0o600});
    return {saved:true,eventCount:events.length};
  });
  ipcMain.handle(IPC_CHANNELS.planningGenerate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().propose(input,localStore().listTasks());
  });
  ipcMain.handle(IPC_CHANNELS.planningProposals,event=>{
    requireTrustedSender(event);
    return planner().proposals();
  });
  ipcMain.handle(IPC_CHANNELS.planningBlocks,event=>{
    requireTrustedSender(event);
    return planner().listCommitted();
  });
  ipcMain.handle(IPC_CHANNELS.planningBatches,event=>{
    requireTrustedSender(event);
    return planner().batches();
  });
  ipcMain.handle(IPC_CHANNELS.planningApply,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().apply(input,localStore().listTasks());
  });
  ipcMain.handle(IPC_CHANNELS.planningUndo,(event,id:unknown)=>{
    requireTrustedSender(event);
    return planner().undo(id);
  });
  ipcMain.handle(IPC_CHANNELS.aiPlanPrepare,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiPlanner().prepare(input);
  });
  ipcMain.handle(IPC_CHANNELS.aiPlanConfirm,(event,approvalId:unknown)=>{
    requireTrustedSender(event);
    return aiPlanner().confirm(approvalId);
  });
  ipcMain.handle(IPC_CHANNELS.aiStatus,event=>{
    requireTrustedSender(event);
    return assistant().status();
  });
  ipcMain.handle(IPC_CHANNELS.aiConnect,(event,input:unknown)=>{
    requireTrustedSender(event);
    return assistant().connect(input);
  });
  ipcMain.handle(IPC_CHANNELS.aiDisconnect,event=>{
    requireTrustedSender(event);
    return assistant().disconnect();
  });
  ipcMain.handle(IPC_CHANNELS.aiPrepare,(event,prompt:unknown)=>{
    requireTrustedSender(event);
    return assistant().prepare(prompt);
  });
  ipcMain.handle(IPC_CHANNELS.aiConfirm,(event,approvalId:unknown)=>{
    requireTrustedSender(event);
    return assistant().confirm(approvalId);
  });
  ipcMain.handle(IPC_CHANNELS.aiCancel,event=>{
    requireTrustedSender(event);
    assistant().cancel();
    return assistant().status();
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraph, event=>{
    requireTrustedSender(event);
    return knowledge().graph();
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraphCreateNode, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().createGraphNode(input);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraphEditNode, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().editGraphNode(input);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraphDeleteNode, (event,id:unknown)=>{
    requireTrustedSender(event);
    return knowledge().deleteGraphNode(id);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraphCreateEdge, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().createGraphEdge(input);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGraphDeleteEdge, (event,id:unknown)=>{
    requireTrustedSender(event);
    return knowledge().deleteGraphEdge(id);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeDocuments, event => {
    requireTrustedSender(event);
    return knowledge().listDocuments();
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeGet, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().getDocument(id);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgePassage,(event,id:unknown,ordinal:unknown)=>{
    requireTrustedSender(event);
    return knowledge().getPassage(id,ordinal);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeImport, async event => {
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner || owner.isDestroyed())throw new Error("Knowledge import requires a trusted window");
    const selection=await dialog.showOpenDialog(owner,{
      title:"选择 PDF、Markdown 或 UTF-8 文本资料",
      properties:["openFile"],
      filters:[{name:"PDF / Markdown / UTF-8 TXT",extensions:["pdf","md","markdown","txt"]}],
    });
    if(selection.canceled || !selection.filePaths.length)return null;
    const source=await readSelectedKnowledgeFile(selection.filePaths[0]);
    return source.format==="pdf" ? knowledge().importPdf(source) : knowledge().importText(source);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeDelete, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().deleteDocument(id);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeSearch, (event,query:unknown) => {
    requireTrustedSender(event);
    return knowledge().search(query);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeCards, event => {
    requireTrustedSender(event);
    return knowledge().listCards();
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeCreateCard, (event,body:unknown) => {
    requireTrustedSender(event);
    return knowledge().createCard(body);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeRemoveCard, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().removeCard(id);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeReviewCard, (event,id:unknown,rating:unknown) => {
    requireTrustedSender(event);
    return knowledge().reviewCard(id,rating);
  });
  ipcMain.handle(IPC_CHANNELS.knowledgeReviewProgress, event => {
    requireTrustedSender(event);
    return knowledge().progress();
  });
  ipcMain.handle(IPC_CHANNELS.backupCreate, async event => {
    requireTrustedSender(event);
    if(!mailStore)throw new Error("Mail database is unavailable");
    return createLocalBackup(app.getPath("userData"),[
      {name:"tasks",store:localStore()},
      {name:"mail",store:mailStore},
      {name:"knowledge",store:knowledge()},
      {name:"planning",store:planner()},
      {name:"calendar",store:fixedCalendar()},
    ]);
  });
  ipcMain.handle(IPC_CHANNELS.focusList, (event) => {
    requireTrustedSender(event);
    return localStore().listFocusSessions();
  });
  ipcMain.handle(IPC_CHANNELS.focusFinish, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().recordFocusSession(input);
  });
  ipcMain.handle(IPC_CHANNELS.focusSummary, (event) => {
    requireTrustedSender(event);
    return localStore().focusSummary();
  });
  ipcMain.handle(IPC_CHANNELS.mailStatus, (event) => {
    requireTrustedSender(event);
    return campusMail().snapshot();
  });
  ipcMain.handle(IPC_CHANNELS.mailConnect, async (event, input: unknown) => {
    requireTrustedSender(event);
    return campusMail().connect(input);
  });
  ipcMain.handle(IPC_CHANNELS.mailList, async (event) => {
    requireTrustedSender(event);
    return campusMail().list();
  });
  ipcMain.handle(IPC_CHANNELS.mailSyncNow, async (event) => {
    requireTrustedSender(event);
    return campusMail().sync();
  });
  ipcMain.handle(IPC_CHANNELS.mailCandidates, async (event) => {
    requireTrustedSender(event);
    const records = await campusMail().list();
    if (!records.length) return [] as MailCandidate[];
    const decisions = new Map(localStore().mailCandidateDecisions(records[0].account)
      .map(item => [`${item.uidValidity}:${item.uid}`,item] as const));
    return records.flatMap(record => {
      const kind = classifyMailSubject(record.subject);
      if (!kind) return [];
      const prior = decisions.get(`${record.uidValidity}:${record.uid}`);
      return [{...record,kind,decision:prior?.decision ?? "pending",
        taskId:prior?.taskId ?? null}] satisfies MailCandidate[];
    });
  });
  ipcMain.handle(IPC_CHANNELS.mailReviewCandidate, async (event, input: unknown) => {
    requireTrustedSender(event);
    const choice = parseMailCandidateChoice(input);
    // The untrusted renderer sends only a source identity and decision, never a
    // title or task content. Main looks up the currently authorized IMAP cache.
    const record = (await campusMail().list()).find(item =>
      item.uid === choice.uid && item.uidValidity === choice.uidValidity &&
      classifyMailSubject(item.subject) !== null);
    if (!record) throw new Error("Mail candidate is no longer in the authorized inbox cache");
    const result = localStore().reviewMailCandidate(record,choice.action);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(MAIL_SYNC_UPDATED);
    }
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.mailDisconnect, async (event) => {
    requireTrustedSender(event);
    const account = campusMail().snapshot().email;
    await campusMail().disconnect();
    if (account) localStore().clearMailCandidateDecisions(account);
    return { disconnected: true as const };
  });
  ipcMain.handle(IPC_CHANNELS.mailPrepareSend, async (event, input: unknown) => {
    requireTrustedSender(event);
    return campusMail().prepareSend(input);
  });
  ipcMain.handle(IPC_CHANNELS.mailConfirmSend, async (event, confirmationId: unknown) => {
    requireTrustedSender(event);
    return campusMail().confirmSend(confirmationId);
  });
  ipcMain.handle(IPC_CHANNELS.canvasStatus, async (event) => {
    requireTrustedSender(event);
    const stored = await credentials().load();
    if (!stored) return { connected: false, baseUrl: null, mode: null };
    return { connected: true, baseUrl: stored.baseUrl, mode: "developer-local-token" };
  });
  ipcMain.handle(IPC_CHANNELS.canvasConnect, async (event, input: unknown) => {
    requireTrustedSender(event);
    const config = parseCanvasPersonalTokenInput(input);
    const api = new CanvasApi(config.baseUrl, config.token);
    // Prove real Canvas API access before persisting encrypted credentials.
    const courses = await api.listCourses();
    await credentials().save({ baseUrl: api.origin, token: config.token });
    // Initial connection starts automatic collection of current-course assignments.
    void coordinator().sync();
    return {
      status: { connected: true, baseUrl: api.origin, mode: "developer-local-token" },
      courses,
    };
  });
  ipcMain.handle(IPC_CHANNELS.canvasCourses, async (event) => {
    requireTrustedSender(event);
    return (await canvasApi()).listCourses();
  });
  ipcMain.handle(IPC_CHANNELS.canvasAssignments, async (event, courseId: unknown) => {
    requireTrustedSender(event);
    return (await canvasApi()).listAssignments(courseId);
  });
  ipcMain.handle(IPC_CHANNELS.canvasImported, async (event, courseInput: unknown) => {
    requireTrustedSender(event);
    const courseId = parseCanvasCourseId(courseInput);
    const api = await canvasApi();
    const accountId = await api.getCurrentUserId();
    return localStore().listImportedCanvasAssignmentIds(api.origin, accountId, courseId);
  });
  ipcMain.handle(IPC_CHANNELS.canvasImportAssignment, async (
    event, courseInput: unknown, assignmentInput: unknown,
  ) => {
    requireTrustedSender(event);
    const courseId = parseCanvasCourseId(courseInput);
    const assignmentId = parseCanvasCourseId(assignmentInput);
    const api = await canvasApi();
    const accountId = await api.getCurrentUserId();
    // Renderer controls only IDs. Fetch the authoritative assignment from Canvas.
    const assignments = await api.listAssignments(courseId);
    const assignment = assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Assignment not present in the currently authorized Canvas course");
    return localStore().importCanvasAssignment(api.origin, accountId, assignment);
  });
  ipcMain.handle(IPC_CHANNELS.canvasSyncCourse, async (event, courseInput: unknown) => {
    requireTrustedSender(event);
    const courseId = parseCanvasCourseId(courseInput);
    const api = await canvasApi();
    const accountId = await api.getCurrentUserId();
    const assignments = await api.listAssignments(courseId);
    return localStore().syncImportedCanvasAssignments(api.origin, accountId, courseId, assignments);
  });
  ipcMain.handle(IPC_CHANNELS.canvasSyncNow, async (event) => {
    requireTrustedSender(event);
    return coordinator().sync();
  });
  ipcMain.handle(IPC_CHANNELS.canvasSyncStatus, (event) => {
    requireTrustedSender(event);
    return coordinator().snapshot();
  });
  ipcMain.handle(IPC_CHANNELS.canvasCourseSettings, async (event) => {
    requireTrustedSender(event);
    return coordinator().courseSettings();
  });
  ipcMain.handle(IPC_CHANNELS.canvasSetCourseEnabled, async (event, input: unknown) => {
    requireTrustedSender(event);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid course synchronization setting");
    }
    const data = input as Record<string, unknown>;
    if (Object.keys(data).sort().join(",") !== "courseId,enabled" ||
      typeof data.courseId !== "number" || typeof data.enabled !== "boolean") {
      throw new Error("Invalid course synchronization setting");
    }
    await coordinator().setCourseEnabled(data.courseId, data.enabled);
    return { saved: true };
  });
  ipcMain.handle(IPC_CHANNELS.canvasDisconnect, async (event) => {
    requireTrustedSender(event);
    coordinator().cancel();
    await credentials().clear();
    return { disconnected: true };
  });
  // Supabase candidate PoC. All REST calls run in Main with the user's JWT;
  // service-role keys are explicitly rejected and never enter renderer storage.
  ipcMain.handle(IPC_CHANNELS.cloudStatus, (event) => {
    requireTrustedSender(event);
    return sharedCloud.status();
  });
  ipcMain.handle(IPC_CHANNELS.cloudConfigure, (event, input: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.configure(input);
  });
  ipcMain.handle(IPC_CHANNELS.cloudLogin, (event, input: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.login(input);
  });
  ipcMain.handle(IPC_CHANNELS.cloudSignup, (event, input: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.signUp(input);
  });
  ipcMain.handle(IPC_CHANNELS.cloudLogout, (event) => {
    requireTrustedSender(event);
    sharedCloud.signOut();
    return sharedCloud.status();
  });
  ipcMain.handle(IPC_CHANNELS.cloudWorkspaces, (event) => {
    requireTrustedSender(event);
    return sharedCloud.listWorkspaces();
  });
  ipcMain.handle(IPC_CHANNELS.cloudCreateWorkspace, (event, name: unknown, displayName: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createWorkspace(name, displayName);
  });
  ipcMain.handle(IPC_CHANNELS.cloudCreateInvite, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createInvite(workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.cloudJoinWorkspace, (event, token: unknown, displayName: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.joinWorkspace(token, displayName);
  });
  ipcMain.handle(IPC_CHANNELS.cloudMembers, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listMembers(workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.cloudMessages, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listMessages(workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.cloudSendMessage, (event, workspaceId: unknown, body: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.sendMessage(workspaceId, body);
  });
  ipcMain.handle(IPC_CHANNELS.cloudTasks, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listTasks(workspaceId);
  });
  ipcMain.handle(IPC_CHANNELS.cloudCreateTask, (event, workspaceId: unknown, input: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createTask(workspaceId, input);
  });
  ipcMain.handle(IPC_CHANNELS.cloudMarkTask, (
    event, workspaceId: unknown, taskId: unknown, completed: unknown,
  ) => {
    requireTrustedSender(event);
    return sharedCloud.markTask(workspaceId, taskId, completed);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f6fa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedSender(targetUrl)) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    // Back up older local schemas BEFORE the constructor runs migrations.
    await backupBeforeMigration(app.getPath("userData"),"ate-local.sqlite",4);
    await backupBeforeMigration(app.getPath("userData"),"ate-knowledge.sqlite",3);
    await backupBeforeMigration(app.getPath("userData"),"ate-fixed-calendar.sqlite",2);
    store = new LocalStore(join(app.getPath("userData"), "ate-local.sqlite"));
    knowledgeStore = new KnowledgeStore(join(app.getPath("userData"), "ate-knowledge.sqlite"));
    fixedCalendarStore = new FixedCalendarStore(
      join(app.getPath("userData"),"ate-fixed-calendar.sqlite"),
      ()=>planningStore?.listCommitted()??[],
    );
    planningStore = new PlanningStore(join(app.getPath("userData"), "ate-plans.sqlite"),
      ()=>fixedCalendar().busySlots());
    aiLedger = new AIUsageLedger(join(app.getPath("userData"), "ate-ai-usage.sqlite"));
    aiService = new AIService(
      new AIKeyVault(join(app.getPath("userData"), "ai-personal.enc"), safeStorage),
      aiLedger,
    );
    // An inaccessible old key does not block offline tasks or knowledge.
    await aiService.initialize().catch(()=>{});
    aiPlanning = new AIPlanningCoordinator(
      aiService,planningStore,()=>localStore().listTasks(),
    );
    canvasVault = new CanvasCredentialVault(join(app.getPath("userData"), "canvas-personal.enc"), safeStorage);
    mailStore = new CampusMailStore(join(app.getPath("userData"), "ate-mail.sqlite"));
    const mailVault = new CampusMailVault(join(app.getPath("userData"), "campus-mail.enc"), safeStorage);
    mailService = new CampusMailService(mailVault, mailStore, undefined, undefined, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(MAIL_SYNC_UPDATED);
      }
    });
    store.purgeExpiredHiddenCanvasTasks();
    canvasSync = new CanvasSyncService(store, async () => {
      const saved = await credentials().load();
      return saved ? new CanvasApi(saved.baseUrl, saved.token) : null;
    }, () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CANVAS_SYNC_UPDATED);
      }
    });
  } catch {
    dialog.showErrorBox(
      "本地数据无法打开",
      "应用无法安全打开本地数据库。请备份用户数据目录后检查磁盘权限或数据库版本；应用不会自动覆盖已有数据。",
    );
    app.quit();
    return;
  }
  registerIpcHandlers();
  createWindow();
  coordinator().start(() => BrowserWindow.getAllWindows().length > 0);
  void coordinator().sync();
  campusMail().start(() => BrowserWindow.getAllWindows().length > 0);
  void campusMail().initialize().then(() => {
    if (mailService) void campusMail().sync();
  }).catch(() => {
    // No credentials or OS encryption support: mail remains disconnected.
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  mailService?.cancel();
  mailService?.stop();
  mailService = null;
  mailStore?.close();
  mailStore = null;
  canvasSync?.cancel();
  canvasSync?.stop();
  canvasSync = null;
  // Sync promises may be finishing; the coordinator aborts before further writes.
  aiPlanning = null;
  aiService?.cancel();
  aiService = null;
  aiLedger?.close();
  aiLedger = null;
  pendingICS=null;
  planningStore?.close();
  planningStore = null;
  fixedCalendarStore?.close();
  fixedCalendarStore=null;
  knowledgeStore?.close();
  knowledgeStore = null;
  store?.close();
  store = null;
});

app.on("window-all-closed", () => {
  // Configurable tray/background modes are a separate W5 system task.
  if (process.platform !== "darwin") app.quit();
});
