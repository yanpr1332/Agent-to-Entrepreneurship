import { app, BrowserWindow, dialog, ipcMain, safeStorage, globalShortcut, type IpcMainInvokeEvent } from "electron";
import { join,basename,extname } from "node:path";
import { configureUserDataOverride } from "./user-data-override";
import {migrateStudyAnchorProfile} from "./profile-migration";
import {mkdirSync} from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat,readFile,writeFile } from "node:fs/promises";
import { FixedCalendarStore } from "./fixed-calendar-store";
import {parseLocalEvaluationLabels,saveLocalEvaluationLabels,
  assertCurrentKnowledgeEvidence} from "./knowledge-quality-audit";
import { parseICS,exportICS } from "../shared/ics-calendar";
import type { ICSPreview,FixedEventDraft } from "../shared/fixed-calendar-model";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS, type IpcChannel } from "../shared/ipc-channels";
import { DiagnosticLogger, protectIpc, type DiagnosticCode } from "./diagnostics";
import { isTrustedRendererUrl } from "../shared/renderer-trust";
import { LocalStore } from "./local-store";
import { CanvasApi } from "./connectors/canvas-api";
import { CanvasCredentialVault } from "./connectors/canvas-credentials";
import { CanvasSyncService } from "./connectors/canvas-sync";
import { SharedCloudClient } from "./cloud/supabase-client";
import { WorkspaceRealtimeBridge } from "./cloud/workspace-realtime";
import {WorkspaceHistoryStore} from "./cloud/workspace-history-store";
import {createTeamHistoryCipher} from "./cloud/workspace-history-crypto";
import {WorkspaceHistoryService} from "./cloud/workspace-history-service";
import { PersonalSyncService } from "./personal-sync";
import {PersonalFileSyncService} from "./personal-file-sync";
import {
  parsePersonalSyncResolutionRequest,parsePersonalSyncLegacyAdoptionRequest,
} from "../shared/personal-sync-contract";
import {listLegacySyncReview,adoptReviewedLegacySync} from "./personal-sync-legacy";
import { parseCanvasCourseId, parseCanvasPersonalTokenInput } from "../shared/canvas-model";
import { CampusMailStore } from "./connectors/mail-store";
import { CampusMailVault } from "./connectors/mail-vault";
import { CampusMailDraftVault } from "./connectors/mail-drafts";
import { CampusMailService } from "./connectors/mail-service";
import { classifyMailSubject, parseMailCandidateChoice } from "../shared/mail-candidates";
import type { MailCandidate } from "../shared/mail-candidates";
import { KnowledgeStore } from "./knowledge-store";
import {KnowledgeOfflineModels} from "./knowledge-offline-models";
import {inspectNeuralRuntime} from "./knowledge-neural-runtime";
import {FocusGuardController} from "./focus-guard";
import {getForegroundApplication} from "./focus-foreground";
import { PlanningStore } from "./planning-store";
import { readSelectedKnowledgeFile } from "./knowledge-import";
import {importPickedKnowledgeFiles,auditKnowledgeSources,refreshAuditedKnowledgeSources}
  from "./knowledge-source-lifecycle";
import { createLocalBackup, backupBeforeMigration } from "./local-backup";
import {inspectRecoveryFolder,recoverToNewProfile} from "./profile-recovery";
import {parseRecoveryConfirmation} from "../shared/recovery-model";
import { AIKeyVault } from "./ai/ai-vault";
import { AIUsageLedger } from "./ai/ai-usage";
import { AIService } from "./ai/ai-service";
import { AIPlanningCoordinator } from "./ai/ai-planner";
import {AIProjectStore} from "./ai/ai-project-store";
import {parseAIProjectSourceGrant} from "../shared/ai-project-model";
import { MailAIReviewCoordinator } from "./ai/mail-ai-coordinator";

/**
 * Local runtime compatibility notice. See docs/w5/16_LOCAL_RUNTIME_TROUBLESHOOTING.md.
 *
 * On some managed Windows hosts Chromium cannot create its sandboxed child
 * processes. The GPU child then fails to launch and Chromium aborts with
 * "GPU process isn't usable. Goodbye." before app.whenReady() runs, so no window
 * ever appears and no in-process fallback is possible.
 *
 * The switch cannot be applied here: Chromium initialises its sandbox before
 * this module is evaluated, so `app.commandLine.appendSwitch("no-sandbox")` has
 * no effect. It must be passed to the Electron command line; electron-vite
 * forwards it through `dev --noSandbox` (npm run dev:compat).
 */
// Logged as a fixed-code safety warning after userData is ready.
const sandboxDisabled=app.commandLine.hasSwitch("no-sandbox");

/**
 * Opt-in relocation of the local data directory. Needed when %APPDATA% is not
 * writable for this process (managed hosts, portable installs, CI). Unset by
 * default so normal installs keep using %APPDATA%\<app name>.
 */
// A failed override must never silently fall back to the default data store.
let userDataOverrideFailure = false;
let customUserData=false;
try {
  app.setName("Study Anchor");
  const modern=process.env.STUDY_ANCHOR_USER_DATA_DIR;
  const legacy=process.env.ATE_USER_DATA_DIR;
  if(modern!==undefined&&legacy!==undefined&&
     modern.trim()!==legacy.trim())
    throw Error("Conflicting userData directory override variables");
  const raw=modern??legacy;
  customUserData=raw!==undefined;
  if(customUserData){
    configureUserDataOverride(raw,(directory)=>app.setPath("userData",directory));
  }else{
    // App data location is explicit, not indirectly derived from the renamed
    // package or installer ID. Used for a one-time legacy directory migration.
    const selected=join(app.getPath("appData"),"Study Anchor");
    mkdirSync(selected,{recursive:true,mode:0o700});
    app.setPath("userData",selected);
  }
  // Never print profile paths, tokens or credentials to normal diagnostics.
}catch{
  userDataOverrideFailure=true;
  console.error("[study-anchor] data directory cannot be initialized.");
}

let diagnostics: DiagnosticLogger | null = null;
function report(code:DiagnosticCode,operation:"app"|"storage"|"canvas"|"mail"|"ai"="app"):void{
  diagnostics?.record(code,operation);
}
let mainWindow: BrowserWindow | null = null;
const focusGuard=new FocusGuardController({
  registerEmergencyShortcut:handler=>
    globalShortcut.register("CommandOrControl+Shift+F12",handler),
  unregisterEmergencyShortcut:()=>
    globalShortcut.unregister("CommandOrControl+Shift+F12"),
},getForegroundApplication);
let store: LocalStore | null = null;
let knowledgeStore: KnowledgeStore | null = null;
let offlineModels:KnowledgeOfflineModels|null=null;
let planningStore: PlanningStore | null = null;
let fixedCalendarStore: FixedCalendarStore | null = null;
let pendingICS:{id:string;expires:number;filename:string;events:FixedEventDraft[]}|null=null;
let pendingRecovery:{id:string;folder:string;fingerprint:string;expires:number}|null=null;
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
let aiProjectStore:AIProjectStore|null=null;
function aiProjects():AIProjectStore{
  if(!aiProjectStore)throw Error("AI project permission storage is unavailable");
  return aiProjectStore;
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
function localModels():KnowledgeOfflineModels{
  if(!offlineModels)throw Error("Local embedding models are not initialized");
  return offlineModels;
}
let canvasVault: CanvasCredentialVault | null = null;
let canvasSync: CanvasSyncService | null = null;
let mailStore: CampusMailStore | null = null;
let mailService: CampusMailService | null = null;
const MAIL_SYNC_UPDATED = "mail:sync-updated";
let mailAIService:MailAIReviewCoordinator|null=null;
function mailAI():MailAIReviewCoordinator{
  if(!mailAIService){
    mailAIService=new MailAIReviewCoordinator(assistant(),{
      list:()=>campusMail().list(),
      readBody:record=>campusMail().readApprovedBody(record),
      decisions:account=>localStore().mailCandidateDecisions(account),
      accept:(record,draft)=>localStore().reviewMailCandidate(record,"accept",draft),
    });
  }
  return mailAIService;
}

function campusMail(): CampusMailService {
  if (!mailService) throw new Error("Campus email is not initialized");
  return mailService;
}
const CANVAS_SYNC_UPDATED = "canvas:sync-updated";
const sharedCloud = new SharedCloudClient();
let workspaceHistoryStore:WorkspaceHistoryStore|null=null;
let workspaceHistoryService:WorkspaceHistoryService|null=null;
function teamHistory():WorkspaceHistoryService{
  if(!workspaceHistoryService)throw Error("Team history database is unavailable");
  return workspaceHistoryService;
}
/** Session changes purge this account's local TEAM cache only. Sign-out must
 * still finish if the optional cache is unavailable; diagnostics never log
 * account IDs, project URLs, messages or crypto error strings. */
function purgeSignedInTeamHistory():void{
  workspaceHistoryService?.cancel();
  if(workspaceHistoryService&&sharedCloud.status().authenticated){
    try{workspaceHistoryService.purgeCurrentAccountCache();}
    catch{report("TEAM_HISTORY_CACHE_PURGE_FAILED","storage");}
  }
}
const workspaceRealtime=new WorkspaceRealtimeBridge(sharedCloud,update=>{
  for(const window of BrowserWindow.getAllWindows()){
    if(!window.isDestroyed())window.webContents.send(IPC_CHANNELS.cloudWorkspaceLiveUpdated,update);
  }
});
let personalSync:PersonalSyncService|null=null;
let personalFiles:PersonalFileSyncService|null=null;
function personalFileService():PersonalFileSyncService{
  if(!personalFiles)throw Error("Personal file synchronization is unavailable");
  return personalFiles;
}
function personalSyncService():PersonalSyncService{
  if(!personalSync)throw new Error("Personal synchronization is not initialized");
  return personalSync;
}

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
  const logger=diagnostics;
  if(!logger)throw new Error("Diagnostics are not initialized");
  // Every renderer->Main handler shares one privacy-preserving error boundary.
  const handle:typeof ipcMain.handle=(channel,listener)=>{
    ipcMain.handle(channel,(event,...args)=>protectIpc(
      channel as IpcChannel,()=>listener(event,...args),logger,
    ));
  };
  handle(IPC_CHANNELS.appPing, (event) => {
    requireTrustedSender(event);
    return { ok: true as const };
  });
  handle(IPC_CHANNELS.appGetVersion, (event) => {
    requireTrustedSender(event);
    return app.getVersion();
  });
  handle(IPC_CHANNELS.tasksList, (event) => {
    requireTrustedSender(event);
    return localStore().listTasks();
  });
  handle(IPC_CHANNELS.tasksCreate, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().createTask(input);
  });
  handle(IPC_CHANNELS.tasksUpdate, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().updateTask(input);
  });
  handle(IPC_CHANNELS.tasksRemove, (event, id: unknown) => {
    requireTrustedSender(event);
    return localStore().removeTask(id);
  });
  handle(IPC_CHANNELS.tasksVisibility, (event, input: unknown) => {
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
  handle(IPC_CHANNELS.fixedCalendarList,event=>{
    requireTrustedSender(event);
    return fixedCalendar().listForDisplay();
  });
  handle(IPC_CHANNELS.canvasCalendarVisibility,(event,input:unknown)=>{
    requireTrustedSender(event);
    if(!input||typeof input!=="object"||Array.isArray(input))
      throw Error("Invalid Canvas calendar visibility request");
    const data=input as Record<string,unknown>;
    if(Object.keys(data).sort().join(",")!=="id,visible")
      throw Error("Invalid Canvas calendar visibility fields");
    return fixedCalendar().setCanvasEventVisibility(data.id,data.visible);
  });
  handle(IPC_CHANNELS.fixedCalendarCreate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().create(input);
  });
  handle(IPC_CHANNELS.fixedCalendarDelete,(event,id:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().delete(id);
  });
  handle(IPC_CHANNELS.fixedCalendarEdit,(event,input:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().edit(input);
  });
  handle(IPC_CHANNELS.fixedCalendarEditSeries,(event,input:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().editSeries(input);
  });
  handle(IPC_CHANNELS.fixedCalendarDeleteSeries,(event,id:unknown)=>{
    requireTrustedSender(event);
    return fixedCalendar().deleteSeries(id);
  });
  handle(IPC_CHANNELS.fixedCalendarPreviewICS,async event=>{
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
  handle(IPC_CHANNELS.fixedCalendarCancelICS,(event,id:unknown)=>{
    requireTrustedSender(event);
    if(pendingICS && id===pendingICS.id)pendingICS=null;
    return {canceled:true};
  });
  handle(IPC_CHANNELS.fixedCalendarConfirmICS,(event,id:unknown)=>{
    requireTrustedSender(event);
    const pending=pendingICS;
    pendingICS=null; // Confirmation is one-use, even on error.
    if(!pending||id!==pending.id||Date.now()>pending.expires)
      throw Error("ICS preview expired; select and review the file again");
    return fixedCalendar().import(pending.events);
  });
  handle(IPC_CHANNELS.fixedCalendarExportICS,async event=>{
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Calendar export requires a trusted window");
    const events=fixedCalendar().list();
    const selection=await dialog.showSaveDialog(owner,{
      title:"导出本机日历（仅固定事件，不含个人任务）",
      defaultPath:"study-anchor-calendar.ics",
      filters:[{name:"iCalendar",extensions:["ics"]}],
    });
    if(selection.canceled||!selection.filePath)return {saved:false,eventCount:0};
    if(extname(selection.filePath).toLowerCase()!==".ics")
      throw Error("Export destination must end in .ics");
    // Never overwrite an existing file or follow an existing symlink.
    await writeFile(selection.filePath,exportICS(events),{encoding:"utf8",flag:"wx",mode:0o600});
    return {saved:true,eventCount:events.length};
  });
  handle(IPC_CHANNELS.planningGenerate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().propose(input,localStore().listTasks());
  });
  handle(IPC_CHANNELS.planningProposals,event=>{
    requireTrustedSender(event);
    return planner().proposals();
  });
  handle(IPC_CHANNELS.planningBlocks,event=>{
    requireTrustedSender(event);
    return planner().listCommitted();
  });
  handle(IPC_CHANNELS.planningBatches,event=>{
    requireTrustedSender(event);
    return planner().batches();
  });
  handle(IPC_CHANNELS.planningApply,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().apply(input,localStore().listTasks());
  });
  handle(IPC_CHANNELS.planningUndo,(event,id:unknown)=>{
    requireTrustedSender(event);
    return planner().undo(id);
  });
  handle(IPC_CHANNELS.planningManualCreate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().createManualBlock(input,localStore().listTasks());
  });
  handle(IPC_CHANNELS.planningBlockUpdate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return planner().updateCommittedBlock(input);
  });
  handle(IPC_CHANNELS.planningBlockRemove,(event,id:unknown)=>{
    requireTrustedSender(event);
    return planner().removeCommittedBlock(id);
  });
  handle(IPC_CHANNELS.aiPlanPrepare,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiPlanner().prepare(input);
  });
  handle(IPC_CHANNELS.aiPlanConfirm,(event,approvalId:unknown)=>{
    requireTrustedSender(event);
    return aiPlanner().confirm(approvalId);
  });
  handle(IPC_CHANNELS.aiPlanCancel,event=>{
    requireTrustedSender(event);
    aiPlanner().cancel();
    assistant().cancel();
    return {cancelled:true as const};
  });
  handle(IPC_CHANNELS.aiProjectsList,event=>{
    requireTrustedSender(event);
    return aiProjects().listProjects();
  });
  handle(IPC_CHANNELS.aiProjectCreate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().createProject(input);
  });
  handle(IPC_CHANNELS.aiProjectRename,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().renameProject(input);
  });
  handle(IPC_CHANNELS.aiProjectArchive,(event,id:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().archiveProject(id);
  });
  handle(IPC_CHANNELS.aiProjectSourceGrants,(event,id:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().listSourceGrants(id);
  });
  handle(IPC_CHANNELS.aiProjectSetSourceGrant,(event,input:unknown)=>{
    requireTrustedSender(event);
    const grant=parseAIProjectSourceGrant(input);
    const source=localStore().listTasks().find(task=>
      task.id===grant.sourceId&&task.visible&&!task.completed&&task.source===null);
    if(!source)throw Error("Only visible, incomplete personal tasks without an external source can be granted to an AI project");
    return aiProjects().setSourceGrant(grant);
  });
  handle(IPC_CHANNELS.aiProjectRevokeSourceGrant,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().revokeSourceGrant(input);
  });
  handle(IPC_CHANNELS.aiProjectActionGrants,(event,id:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().listActionGrants(id);
  });
  handle(IPC_CHANNELS.aiProjectSetActionGrant,(event,input:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().setActionGrant(input);
  });
  handle(IPC_CHANNELS.aiProjectAudit,(event,id:unknown)=>{
    requireTrustedSender(event);
    return aiProjects().auditEvents(id);
  });
  handle(IPC_CHANNELS.aiStatus,event=>{
    requireTrustedSender(event);
    return assistant().status();
  });
  handle(IPC_CHANNELS.aiConnect,(event,input:unknown)=>{
    requireTrustedSender(event);
    return assistant().connect(input);
  });
  handle(IPC_CHANNELS.aiDisconnect,event=>{
    requireTrustedSender(event);
    mailAIService?.cancel();
    aiPlanning?.cancel();
    return assistant().disconnect();
  });
  handle(IPC_CHANNELS.aiPrepare,(event,prompt:unknown)=>{
    requireTrustedSender(event);
    return assistant().prepare(prompt);
  });
  handle(IPC_CHANNELS.aiConfirm,(event,approvalId:unknown)=>{
    requireTrustedSender(event);
    return assistant().confirm(approvalId);
  });
  handle(IPC_CHANNELS.aiCancel,event=>{
    requireTrustedSender(event);
    assistant().cancel();
    aiPlanning?.cancel();
    return assistant().status();
  });
  handle(IPC_CHANNELS.knowledgeGraph, event=>{
    requireTrustedSender(event);
    return knowledge().graph();
  });
  handle(IPC_CHANNELS.knowledgeGraphCreateNode, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().createGraphNode(input);
  });
  handle(IPC_CHANNELS.knowledgeGraphEditNode, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().editGraphNode(input);
  });
  handle(IPC_CHANNELS.knowledgeGraphDeleteNode, (event,id:unknown)=>{
    requireTrustedSender(event);
    return knowledge().deleteGraphNode(id);
  });
  handle(IPC_CHANNELS.knowledgeGraphCreateEdge, (event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().createGraphEdge(input);
  });
  handle(IPC_CHANNELS.knowledgeGraphDeleteEdge, (event,id:unknown)=>{
    requireTrustedSender(event);
    return knowledge().deleteGraphEdge(id);
  });
  handle(IPC_CHANNELS.knowledgeDocuments, event => {
    requireTrustedSender(event);
    return knowledge().listDocuments();
  });
  handle(IPC_CHANNELS.knowledgeGet, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().getDocument(id);
  });
  handle(IPC_CHANNELS.knowledgePassage,(event,id:unknown,ordinal:unknown)=>{
    requireTrustedSender(event);
    return knowledge().getPassage(id,ordinal);
  });
  handle(IPC_CHANNELS.knowledgeImport, async event => {
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner || owner.isDestroyed())throw new Error("Knowledge import requires a trusted window");
    const selection=await dialog.showOpenDialog(owner,{
      title:"选择 PDF、Markdown、HTML、LaTeX 或 UTF-8 文本资料",
      properties:["openFile"],
      filters:[{name:"PDF / Markdown / HTML / LaTeX / TXT",
        extensions:["pdf","md","markdown","html","htm","tex","latex","txt"]}],
    });
    if(selection.canceled || !selection.filePaths.length)return null;
    const source=await readSelectedKnowledgeFile(selection.filePaths[0]);
    return source.format==="pdf" ? knowledge().importPdf(source) : knowledge().importText(source);
  });
  handle(IPC_CHANNELS.knowledgeBatchImport,async event=>{
    requireTrustedSender(event);
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Batch import requires a trusted window");
    const selection=await dialog.showOpenDialog(owner,{
      title:"批量选择本机知识库资料（一次最多 20 份）",
      properties:["openFile","multiSelections"],
      filters:[{name:"PDF / Markdown / HTML / LaTeX / TXT",
        extensions:["pdf","md","markdown","html","htm","tex","latex","txt"]}],
    });
    if(selection.canceled||!selection.filePaths.length)return null;
    return importPickedKnowledgeFiles(knowledge(),selection.filePaths);
  });
  handle(IPC_CHANNELS.knowledgeAuditSources,(event,ids:unknown)=>{
    requireTrustedSender(event);
    return auditKnowledgeSources(knowledge(),ids);
  });
  handle(IPC_CHANNELS.knowledgeRefreshSources,
    (event,consent:unknown,requests:unknown)=>{
      requireTrustedSender(event);
      if(consent!==true)throw Error("Explicit local source refresh consent required");
      return refreshAuditedKnowledgeSources(knowledge(),requests);
    });
  handle(IPC_CHANNELS.knowledgeDelete, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().deleteDocument(id);
  });
  handle(IPC_CHANNELS.knowledgeEmbeddingStatus, event => {
    requireTrustedSender(event);
    return localModels().status();
  });
  handle(IPC_CHANNELS.knowledgeImportOfflineModel, async(event,accepted:unknown)=>{
    requireTrustedSender(event);
    if(accepted!==true)throw Error("Explicit local model import consent required");
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Model import requires a trusted window");
    const selection=await dialog.showOpenDialog(owner,{
      title:"选择你已核对来源与许可的本机 UTF-8 词向量 .vec 文件",
      properties:["openFile"],
      filters:[{name:"静态词向量文件",extensions:["vec"]}],
    });
    if(selection.canceled||!selection.filePaths.length)return null;
    return localModels().importFile(selection.filePaths[0]);
  });
  handle(IPC_CHANNELS.knowledgeNeuralRuntimeCheck,async(event)=>{
    requireTrustedSender(event);
    const script=app.isPackaged?
      join(process.resourcesPath,"neural-runtime-doctor.py"):
      join(process.cwd(),"scripts","neural-runtime-doctor.py");
    return inspectNeuralRuntime(script);
  });
  handle(IPC_CHANNELS.knowledgeImportNeuralModel,
    async(event,consent:unknown,kind:unknown)=>{
      requireTrustedSender(event);
      if(consent!==true)
        throw Error("Explicit third-party neural model license consent required");
      if(kind!=="e5"&&kind!=="bge")throw Error("Unsupported neural model family");
      const owner=BrowserWindow.fromWebContents(event.sender);
      if(!owner||owner.isDestroyed())throw Error("Neural import requires a trusted window");
      const selection=await dialog.showOpenDialog(owner,{
        title:kind==="e5"?"选择 multilingual-e5-small 的本地 ONNX 文件夹":
          "选择 bge-small-zh-v1.5 的本地 ONNX 文件夹",
        properties:["openDirectory"],
      });
      if(selection.canceled||!selection.filePaths.length)return null;
      return localModels().importNeuralDirectory(selection.filePaths[0],kind);
    });
  handle(IPC_CHANNELS.knowledgeStartOfflineIndex,event=>{
    requireTrustedSender(event);
    return localModels().startIndex();
  });
  handle(IPC_CHANNELS.knowledgeCancelOfflineIndex,event=>{
    requireTrustedSender(event);
    return localModels().cancel();
  });
  handle(IPC_CHANNELS.knowledgeRemoveOfflineModel,(event,confirmation:unknown)=>{
    requireTrustedSender(event);
    if(confirmation!=="REMOVE_LOCAL_MODEL_AND_VECTORS")
      throw Error("Explicit local model removal confirmation required");
    return localModels().remove();
  });
  handle(IPC_CHANNELS.knowledgeEvaluateOfflineModel,async(event,consent:unknown)=>{
    requireTrustedSender(event);
    if(consent!==true)throw Error("Explicit local evaluation consent required");
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Evaluation requires trusted window");
    const selection=await dialog.showOpenDialog(owner,{
      title:"选择你本地编写的检索相关性标签 JSON（只在本机使用）",
      properties:["openFile"],
      filters:[{name:"本地检索标注",extensions:["json"]}],
    });
    if(selection.canceled||!selection.filePaths.length)return null;
    return localModels().evaluateFile(selection.filePaths[0]);
  });
  handle(IPC_CHANNELS.knowledgeEvidencePage,(event,offset:unknown)=>{
    requireTrustedSender(event);
    if(!Number.isSafeInteger(offset)||(offset as number)<0||
      (offset as number)>100000)throw Error("Invalid evidence catalog offset");
    return knowledge().localEvidenceCatalog(50,offset as number);
  });
  handle(IPC_CHANNELS.knowledgeSaveEvaluationLabels,
    async(event,consent:unknown,raw:unknown)=>{
      requireTrustedSender(event);
      if(consent!==true)
        throw Error("Explicit private evaluation label export consent required");
      const cases=parseLocalEvaluationLabels(raw);
      const owner=BrowserWindow.fromWebContents(event.sender);
      if(!owner||owner.isDestroyed())
        throw Error("Private evaluation label export requires trusted window");
      const target=await dialog.showSaveDialog(owner,{
        title:"保存人工检索相关性标注（私人查询和证据引用）",
        defaultPath:"study-anchor-relevance-labels.json",
        filters:[{name:"本地检索评测标签",extensions:["json"]}],
      });
      if(target.canceled||!target.filePath)return null;
      const check=(key:string)=>assertCurrentKnowledgeEvidence(key,
        (id,ordinal)=>knowledge().getPassage(id,ordinal));
      const count=saveLocalEvaluationLabels(
        target.filePath,{schema:1,cases},check);
      return {path:target.filePath,cases:count};
    });
  handle(IPC_CHANNELS.knowledgeExportEvidenceCatalog,async(event,consent:unknown)=>{
    requireTrustedSender(event);
    if(consent!==true)throw Error("Explicit local evidence export consent required");
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||owner.isDestroyed())throw Error("Evidence export requires trusted window");
    const target=await dialog.showSaveDialog(owner,{
      title:"导出本机知识库证据目录（含私人原文片段摘要）",
      defaultPath:"study-anchor-evidence-catalog.json",
      filters:[{name:"JSON 证据目录",extensions:["json"]}],
    });
    if(target.canceled||!target.filePath)return null;
    const data=knowledge().localEvidenceCatalog(500);
    // Refuse to overwrite an existing file silently. The exported catalog
    // may include private text and must not be auto-uploaded.
    await writeFile(target.filePath,JSON.stringify({
      schema:1,kind:"study-anchor-evidence-catalog",
      createdAt:new Date().toISOString(),
      total:data.total,truncated:data.total>data.items.length,
      items:data.items,
      labelFormat:{schema:1,cases:[{id:"your-case-id",
        query:"your-manually-written-question",
        relevant:["document-uuid:revision:ordinal"]}]},
    },null,2),{mode:0o600,flag:"wx"});
    return {path:target.filePath,exported:data.items.length,
      total:data.total,truncated:data.total>data.items.length};
  });
  handle(IPC_CHANNELS.knowledgeSearch, (event,query:unknown) => {
    requireTrustedSender(event);
    return localModels().search(query);
  });
  handle(IPC_CHANNELS.knowledgeCards, event => {
    requireTrustedSender(event);
    return knowledge().listCards();
  });
  handle(IPC_CHANNELS.knowledgeCreateCard, (event,body:unknown) => {
    requireTrustedSender(event);
    return knowledge().createCard(body);
  });
  handle(IPC_CHANNELS.knowledgeEditCard,(event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().editCard(input);
  });
  handle(IPC_CHANNELS.knowledgeRebindCard,(event,input:unknown)=>{
    requireTrustedSender(event);
    return knowledge().rebindCardEvidence(input);
  });
  handle(IPC_CHANNELS.knowledgeCardEvidenceHistory,(event,id:unknown)=>{
    requireTrustedSender(event);
    return knowledge().cardEvidenceHistory(id);
  });
  handle(IPC_CHANNELS.knowledgeRemoveCard, (event,id:unknown) => {
    requireTrustedSender(event);
    return knowledge().removeCard(id);
  });
  handle(IPC_CHANNELS.knowledgeReviewCard, (event,id:unknown,rating:unknown) => {
    requireTrustedSender(event);
    return knowledge().reviewCard(id,rating);
  });
  handle(IPC_CHANNELS.knowledgeReviewProgress, event => {
    requireTrustedSender(event);
    return knowledge().progress();
  });
  handle(IPC_CHANNELS.backupInspect,async event=>{
    requireTrustedSender(event);
    pendingRecovery=null;
    const chosen=await dialog.showOpenDialog({
      title:"选择现有 Study Anchor 备份目录（包含 manifest.json）",
      defaultPath:join(app.getPath("userData"),"backups"),
      properties:["openDirectory"],buttonLabel:"检查备份",
    });
    if(chosen.canceled||chosen.filePaths.length!==1)return null;
    const folder=chosen.filePaths[0];
    const inspection=await inspectRecoveryFolder(folder);
    const id=randomUUID(),expires=Date.now()+10*60_000;
    pendingRecovery={id,folder,fingerprint:inspection.fingerprint,expires};
    return {reviewId:id,expiresAt:new Date(expires).toISOString(),
      createdAt:inspection.createdAt,databases:inspection.databases,
      missing:inspection.missing,legacyManifest:inspection.legacyManifest};
  });
  handle(IPC_CHANNELS.backupRestore,async(event,raw:unknown)=>{
    requireTrustedSender(event);
    const input=parseRecoveryConfirmation(raw),review=pendingRecovery;
    pendingRecovery=null;
    if(!review||review.id!==input.reviewId||review.expires<Date.now())
      throw Error("备份核验授权已失效，请重新选择备份。");
    const target=await dialog.showSaveDialog({
      title:"为恢复数据选择一个不存在的新配置目录名称（不会覆盖现有数据）",
      defaultPath:join(app.getPath("documents"),"Study Anchor Recovered "+
        new Date().toISOString().slice(0,10)),
      buttonLabel:"创建独立恢复配置",
    });
    if(target.canceled||!target.filePath)return null;
    return recoverToNewProfile({
      folder:review.folder,destination:target.filePath,
      activeUserData:app.getPath("userData"),expectedFingerprint:review.fingerprint,
    });
  });
  handle(IPC_CHANNELS.backupCancel,event=>{
    requireTrustedSender(event);pendingRecovery=null;return {canceled:true as const};
  });
  handle(IPC_CHANNELS.backupCreate, async event => {
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
  handle(IPC_CHANNELS.focusGuardStart,(event,input:unknown)=>{
    requireTrustedSender(event);
    const window=BrowserWindow.fromWebContents(event.sender);
    if(!window||window!==mainWindow||window.isDestroyed())
      throw Error("Focus protection requires the active desktop window");
    return focusGuard.start(input,window);
  });
  handle(IPC_CHANNELS.focusGuardStatus,(event)=>{
    requireTrustedSender(event);
    return focusGuard.status();
  });
  handle(IPC_CHANNELS.focusGuardStop,(event)=>{
    requireTrustedSender(event);
    return focusGuard.stop();
  });
  handle(IPC_CHANNELS.focusList, (event) => {
    requireTrustedSender(event);
    return localStore().listFocusSessions();
  });
  handle(IPC_CHANNELS.focusFinish, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().recordFocusSession(input);
  });
  handle(IPC_CHANNELS.focusRename, (event, input: unknown) => {
    requireTrustedSender(event);
    return localStore().renameFocusSession(input);
  });
  handle(IPC_CHANNELS.focusSummary, (event) => {
    requireTrustedSender(event);
    return localStore().focusSummary();
  });
  handle(IPC_CHANNELS.focusInsights,(event,zone:unknown)=>{
    requireTrustedSender(event);
    return localStore().focusInsights(zone);
  });
  handle(IPC_CHANNELS.focusRewards,(event)=>{
    requireTrustedSender(event);
    return localStore().focusRewards();
  });
  handle(IPC_CHANNELS.focusRewardCreate,(event,input:unknown)=>{
    requireTrustedSender(event);
    return localStore().createFocusReward(input);
  });
  handle(IPC_CHANNELS.focusRewardEdit,(event,input:unknown)=>{
    requireTrustedSender(event);
    return localStore().editFocusReward(input);
  });
  handle(IPC_CHANNELS.focusRewardRedeem,(event,input:unknown)=>{
    requireTrustedSender(event);
    return localStore().redeemFocusReward(input);
  });
  handle(IPC_CHANNELS.mailStatus, (event) => {
    requireTrustedSender(event);
    return campusMail().snapshot();
  });
  handle(IPC_CHANNELS.mailConnect, async (event, input: unknown) => {
    requireTrustedSender(event);
    return campusMail().connect(input);
  });
  handle(IPC_CHANNELS.mailList, async (event) => {
    requireTrustedSender(event);
    return campusMail().list();
  });
  handle(IPC_CHANNELS.mailReadBody, async (event, record: unknown) => {
    requireTrustedSender(event);
    return campusMail().readApprovedBody(record as import("../shared/mail-model").MailRecord);
  });
  handle(IPC_CHANNELS.mailSavedDrafts, async (event) => {
    requireTrustedSender(event);
    return campusMail().listSavedDrafts();
  });
  handle(IPC_CHANNELS.mailSaveDraft, async (event, input: unknown) => {
    requireTrustedSender(event);
    return campusMail().saveDraft(input);
  });
  handle(IPC_CHANNELS.mailDeleteDraft, async (event, id: unknown) => {
    requireTrustedSender(event);
    await campusMail().deleteDraft(id);
    return {deleted:true as const};
  });
  handle(IPC_CHANNELS.mailSyncNow, async (event) => {
    requireTrustedSender(event);
    return campusMail().sync();
  });
  handle(IPC_CHANNELS.mailAIPrepare,async(event,selection:unknown)=>{
    requireTrustedSender(event);
    return mailAI().prepare(selection);
  });
  handle(IPC_CHANNELS.mailAIConfirm,async(event,approvalId:unknown)=>{
    requireTrustedSender(event);
    return mailAI().confirm(approvalId);
  });
  handle(IPC_CHANNELS.mailAIApply,async(event,input:unknown)=>{
    requireTrustedSender(event);
    const result=await mailAI().apply(input);
    for(const window of BrowserWindow.getAllWindows()){
      if(!window.isDestroyed())window.webContents.send(MAIL_SYNC_UPDATED);
    }
    return result;
  });
  handle(IPC_CHANNELS.mailAICancel,event=>{
    requireTrustedSender(event);
    mailAIService?.cancel();
    assistant().cancel();
    aiPlanning?.cancel();
    return {canceled:true as const};
  });
  handle(IPC_CHANNELS.mailCandidates, async (event) => {
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
  handle(IPC_CHANNELS.mailReviewCandidate, async (event, input: unknown) => {
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
  handle(IPC_CHANNELS.mailDisconnect, async (event) => {
    requireTrustedSender(event);
    mailAIService?.cancel();
    assistant().cancel();
    const account = campusMail().snapshot().email;
    await campusMail().disconnect();
    if (account) localStore().clearMailCandidateDecisions(account);
    return { disconnected: true as const };
  });
  handle(IPC_CHANNELS.mailPrepareSend, async (event, input: unknown) => {
    requireTrustedSender(event);
    return campusMail().prepareSend(input);
  });
  handle(IPC_CHANNELS.mailConfirmSend, async (event, confirmationId: unknown) => {
    requireTrustedSender(event);
    return campusMail().confirmSend(confirmationId);
  });
  handle(IPC_CHANNELS.canvasStatus, async (event) => {
    requireTrustedSender(event);
    const stored = await credentials().load();
    if (!stored) return { connected: false, baseUrl: null, mode: null };
    return { connected: true, baseUrl: stored.baseUrl, mode: "developer-local-token" };
  });
  handle(IPC_CHANNELS.canvasConnect, async (event, input: unknown) => {
    requireTrustedSender(event);
    const config = parseCanvasPersonalTokenInput(input);
    const api = new CanvasApi(config.baseUrl, config.token);
    // Prove real Canvas API access before persisting encrypted credentials.
    const [courses] = await Promise.all([api.listCourses(),api.getCurrentUserId()]);
    // A replacement Token may belong to a different Canvas account. Fence old syncs.
    coordinator().cancel();
    await credentials().save({ baseUrl: api.origin, token: config.token });
    // Initial connection starts automatic collection of current-course assignments.
    void coordinator().sync();
    return {
      status: { connected: true, baseUrl: api.origin, mode: "developer-local-token" },
      courses,
    };
  });
  handle(IPC_CHANNELS.canvasCourses, async (event) => {
    requireTrustedSender(event);
    return (await canvasApi()).listCourses();
  });
  handle(IPC_CHANNELS.canvasAssignments, async (event, courseId: unknown) => {
    requireTrustedSender(event);
    return (await canvasApi()).listAssignments(courseId);
  });
  handle(IPC_CHANNELS.canvasImported, async (event, courseInput: unknown) => {
    requireTrustedSender(event);
    const courseId = parseCanvasCourseId(courseInput);
    const api = await canvasApi();
    const accountId = await api.getCurrentUserId();
    return localStore().listImportedCanvasAssignmentIds(api.origin, accountId, courseId);
  });
  handle(IPC_CHANNELS.canvasImportAssignment, async (
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
  handle(IPC_CHANNELS.canvasSyncCourse, async (event, courseInput: unknown) => {
    requireTrustedSender(event);
    const courseId = parseCanvasCourseId(courseInput);
    const api = await canvasApi();
    const accountId = await api.getCurrentUserId();
    const assignments = await api.listAssignments(courseId);
    return localStore().syncImportedCanvasAssignments(api.origin, accountId, courseId, assignments);
  });
  handle(IPC_CHANNELS.canvasSyncNow, async (event) => {
    requireTrustedSender(event);
    return coordinator().sync();
  });
  handle(IPC_CHANNELS.canvasSyncStatus, (event) => {
    requireTrustedSender(event);
    return coordinator().snapshot();
  });
  handle(IPC_CHANNELS.canvasCourseSettings, async (event) => {
    requireTrustedSender(event);
    return coordinator().courseSettings();
  });
  handle(IPC_CHANNELS.canvasSetCourseEnabled, async (event, input: unknown) => {
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
  handle(IPC_CHANNELS.canvasDisconnect, async (event) => {
    requireTrustedSender(event);
    coordinator().cancel();
    await credentials().clear();
    return { disconnected: true };
  });
  // Supabase candidate PoC. All REST calls run in Main with the user's JWT;
  // service-role keys are explicitly rejected and never enter renderer storage.
  handle(IPC_CHANNELS.cloudStatus, (event) => {
    requireTrustedSender(event);
    return sharedCloud.status();
  });
  handle(IPC_CHANNELS.cloudConfigure, (event, input: unknown) => {
    requireTrustedSender(event);
    pendingRecovery=null;
  workspaceRealtime.stop();
    purgeSignedInTeamHistory();
    return sharedCloud.configure(input);
  });
  handle(IPC_CHANNELS.cloudLogin, (event, input: unknown) => {
    requireTrustedSender(event);
    workspaceRealtime.stop();
    purgeSignedInTeamHistory();
    return sharedCloud.login(input);
  });
  handle(IPC_CHANNELS.cloudSignup, (event, input: unknown) => {
    requireTrustedSender(event);
    workspaceRealtime.stop();
    purgeSignedInTeamHistory();
    return sharedCloud.signUp(input);
  });
  handle(IPC_CHANNELS.cloudLogout, (event) => {
    requireTrustedSender(event);
    workspaceRealtime.stop();
    purgeSignedInTeamHistory();
    sharedCloud.signOut();
    return sharedCloud.status();
  });
  handle(IPC_CHANNELS.cloudWorkspaces, (event) => {
    requireTrustedSender(event);
    return sharedCloud.listWorkspaces();
  });
  handle(IPC_CHANNELS.cloudCreateWorkspace, (event, name: unknown, displayName: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createWorkspace(name, displayName);
  });
  handle(IPC_CHANNELS.cloudCreateInvite, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createInvite(workspaceId);
  });
  handle(IPC_CHANNELS.cloudJoinWorkspace, (event, token: unknown, displayName: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.joinWorkspace(token, displayName);
  });
  handle(IPC_CHANNELS.cloudRevokeMember, async (event, workspaceId:unknown,userId:unknown) => {
    requireTrustedSender(event);
    const result=await sharedCloud.revokeWorkspaceMember(workspaceId,userId);
    // A member on another device is cut off by service RLS; local live watchers
    // also revalidate membership on the next refresh. No client can grant access.
    return result;
  });
  handle(IPC_CHANNELS.cloudMembers, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listMembers(workspaceId);
  });
  handle(IPC_CHANNELS.cloudMessages, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listMessages(workspaceId);
  });
  handle(IPC_CHANNELS.cloudWorkspaceSnapshot, (event, workspaceId:unknown) => {
    requireTrustedSender(event);
    return workspaceHistoryService
      ? workspaceHistoryService.snapshot(workspaceId)
      : sharedCloud.workspaceSnapshot(workspaceId);
  });
  handle(IPC_CHANNELS.cloudClearTeamHistory, (event,confirmation:unknown)=>{
    requireTrustedSender(event);
    if(confirmation!=="ERASE_CURRENT_TEAM_CACHE")
      throw Error("Explicit team cache deletion confirmation required");
    return teamHistory().purgeCurrentAccountCache();
  });
  handle(IPC_CHANNELS.cloudWorkspaceHistoryOlder, (event,workspaceId:unknown,
    kind:"message"|"task",before:unknown) => {
    requireTrustedSender(event);
    return teamHistory().older(workspaceId,kind,before);
  });
  handle(IPC_CHANNELS.cloudWatchWorkspace, (event, workspaceId:unknown) => {
    requireTrustedSender(event);
    return workspaceRealtime.watch(workspaceId);
  });
  handle(IPC_CHANNELS.cloudStopWorkspaceWatch, (event, workspaceId:unknown) => {
    requireTrustedSender(event);
    return workspaceRealtime.stopWatching(workspaceId);
  });
  handle(IPC_CHANNELS.cloudSendMessage, (event, workspaceId: unknown, body: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.sendMessage(workspaceId, body);
  });
  handle(IPC_CHANNELS.cloudTasks, (event, workspaceId: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.listTasks(workspaceId);
  });
  handle(IPC_CHANNELS.cloudCreateTask, (event, workspaceId: unknown, input: unknown) => {
    requireTrustedSender(event);
    return sharedCloud.createTask(workspaceId, input);
  });
  handle(IPC_CHANNELS.cloudMarkTask, (
    event, workspaceId: unknown, taskId: unknown, completed: unknown,
  ) => {
    requireTrustedSender(event);
    return sharedCloud.markTask(workspaceId, taskId, completed);
  });
  // File staging is native-picker-only: IPC NEVER accepts a filesystem path.
  handle(IPC_CHANNELS.cloudFileOverview, (event) => {
    requireTrustedSender(event);
    return personalFileService().overview();
  });
  handle(IPC_CHANNELS.cloudFileStage, async(event,replaceInput:unknown)=>{
    requireTrustedSender(event);
    let replacement:{fileId:string;version:number}|undefined;
    if(replaceInput!==null){
      if(!replaceInput||typeof replaceInput!=="object"||Array.isArray(replaceInput))
        throw Error("Invalid file replacement request");
      const input=replaceInput as Record<string,unknown>;
      if(Object.keys(input).sort().join(",")!=="fileId,version")
        throw Error("Invalid file replacement request");
      replacement={fileId:String(input.fileId),version:Number(input.version)};
    }
    // Dialog is controlled by Main and constrained to one file. The selected
    // absolute path and its contents are never returned to Renderer.
    const result=await dialog.showOpenDialog({
      title:"选择一个准备手动同步的个人文件（最大 1 MiB）",
      properties:["openFile"],
      filters:[{name:"个人学习文件",extensions:[
        "md","txt","pdf","html","htm","tex","latex","csv","json","ics",
      ]}],
    });
    if(result.canceled||result.filePaths.length!==1)return null;
    return personalFileService().stagePickedFile(result.filePaths[0],replacement);
  });
  handle(IPC_CHANNELS.cloudFileUpload,async(event,id:unknown)=>{
    requireTrustedSender(event);
    const fileId=typeof id==="string"?id:"";
    const item=personalFileService().pending().find(row=>row.fileId===fileId);
    if(!item)throw Error("No staged personal file for the current account");
    // A forged Renderer IPC cannot bypass this native OS confirmation.
    const answer=await dialog.showMessageBox({
      type:"warning",buttons:["同意上传到当前测试云项目","取消，不上传"],
      defaultId:1,cancelId:1,noLink:true,
      title:"确认上传个人文件",
      message:"是否上传「"+item.filename+"」？",
      detail:"文件大小："+item.byteLength+" 字节。将发送完整原文到当前 Supabase 项目。"+
        "此 Beta 不提供端到端加密，项目管理员可能访问内容。"+
        "只有明确确认才会进行网络写入。",
    });
    if(answer.response!==0)return {status:"cancelled" as const,version:null};
    return personalFileService().upload(fileId);
  });
  handle(IPC_CHANNELS.cloudFileStopLocal,(event,id:unknown)=>{
    requireTrustedSender(event);
    return personalFileService().stopLocal(id);
  });
  handle(IPC_CHANNELS.cloudFileDownload,(event,id:unknown,version:unknown)=>{
    requireTrustedSender(event);
    return personalFileService().download(id,version);
  });
  handle(IPC_CHANNELS.cloudFileDelete,async(event,id:unknown,version:unknown)=>{
    requireTrustedSender(event);
    const fileId=typeof id==="string"?id:"";
    const item=(await personalFileService().overview()).remote
      .find(row=>row.fileId===fileId&&row.version===version);
    if(!item)throw Error("Remote file version changed; refresh before deleting");
    const answer=await dialog.showMessageBox({
      type:"warning",buttons:["确认删除该云端文件内容","取消，保留文件"],
      defaultId:1,cancelId:1,noLink:true,
      title:"确认删除当前云端文件内容",
      message:"从 Supabase 删除「"+item.filename+"」v"+item.version+" 的原文？",
      detail:"这会按版本核对并清空当前云端记录的文件内容。"+
        "其他电脑已经下载的副本和云服务历史备份不会自动清除。",
    });
    if(answer.response!==0)return {status:"cancelled" as const,version:null};
    return personalFileService().deleteRemote(fileId,version);
  });
  handle(IPC_CHANNELS.cloudPersonalSyncNow, async (event) => {
    requireTrustedSender(event);
    return personalSyncService().syncNow();
  });
  handle(IPC_CHANNELS.cloudReviewPersonalSyncDeviceReplacement, (event) => {
    requireTrustedSender(event);
    return personalSyncService().reviewDeviceReplacement();
  });
  handle(IPC_CHANNELS.cloudConfirmPersonalSyncDeviceReplacement, async (event,input:unknown) => {
    requireTrustedSender(event);
    return personalSyncService().replaceDevice(input);
  });
  handle(IPC_CHANNELS.cloudInspectPersonalSyncRecovery, async (event) => {
    requireTrustedSender(event);
    return personalSyncService().inspectRecovery();
  });
  handle(IPC_CHANNELS.cloudReviewPersonalSyncReceipts, async (event) => {
    requireTrustedSender(event);
    return personalSyncService().reviewReceipts();
  });
  handle(IPC_CHANNELS.cloudDiscardPersonalSyncReceiptReview, (event) => {
    requireTrustedSender(event);
    return personalSyncService().discardReceiptReview();
  });
  handle(IPC_CHANNELS.cloudReconcilePersonalSyncReceipts, async (event,input:unknown) => {
    requireTrustedSender(event);
    return personalSyncService().reconcileReceipts(input);
  });
  handle(IPC_CHANNELS.cloudPersonalSyncCandidates, (event) => {
    requireTrustedSender(event);
    const ownerId=sharedCloud.currentUserId();
    return [
      ...localStore().listPersonalSyncCandidates(ownerId),
      ...fixedCalendar().listManualCalendarSyncCandidates(ownerId),
    ];
  });
  handle(IPC_CHANNELS.cloudSetPersonalTaskSync, (event,input:unknown) => {
    requireTrustedSender(event);
    if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Invalid task sync preference");
    const row=input as Record<string,unknown>;
    if(Object.keys(row).sort().join(",")!=="enabled,id"||typeof row.enabled!=="boolean")
      throw Error("Invalid task sync preference");
    localStore().setTaskSyncEnabled(row.id,row.enabled,sharedCloud.currentUserId());
    return {saved:true as const};
  });
  handle(IPC_CHANNELS.cloudSetManualEventSync, (event,input:unknown) => {
    requireTrustedSender(event);
    if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Invalid calendar sync preference");
    const row=input as Record<string,unknown>;
    if(Object.keys(row).sort().join(",")!=="enabled,id"||typeof row.enabled!=="boolean"||
      typeof row.id!=="string")throw Error("Invalid calendar sync preference");
    fixedCalendar().setManualEventSyncEnabled(row.id,row.enabled,sharedCloud.currentUserId());
    return {saved:true as const};
  });
  handle(IPC_CHANNELS.cloudPersonalSyncConflicts, (event) => {
    requireTrustedSender(event);
    return personalSyncService().listConflicts();
  });
  handle(IPC_CHANNELS.cloudPersonalSyncLegacyReview, (event) => {
    requireTrustedSender(event);
    // Listing is local-only; require a signed-in owner so the UI never
    // presents ownerless rows as already belonging to a selected account.
    sharedCloud.currentUserId();
    return listLegacySyncReview(localStore(),fixedCalendar());
  });
  handle(IPC_CHANNELS.cloudAdoptPersonalSyncLegacy, (event,input:unknown) => {
    requireTrustedSender(event);
    const ownerId=sharedCloud.currentUserId();
    const request=parsePersonalSyncLegacyAdoptionRequest(input);
    if(personalSyncService().hasInFlightRun())
      throw Error("Wait for personal sync to finish before re-authorizing old data");
    adoptReviewedLegacySync(localStore(),fixedCalendar(),ownerId,request);
    // Adoption creates an owner-scoped *local pending operation* only.
    // There is no network request until the user separately clicks sync.
    return {saved:true as const};
  });
  handle(IPC_CHANNELS.cloudResolvePersonalSyncConflict, async (event,input:unknown) => {
    requireTrustedSender(event);
    const choice=parsePersonalSyncResolutionRequest(input);
    const ownerId=sharedCloud.currentUserId();
    const service=personalSyncService();
    if(service.hasInFlightRun())throw Error("Personal sync is in progress; retry when idle");
    // Destructive local adoption requires an up-to-date, fully drained remote
    // pull. Keep-local is also refreshed to avoid rebase on a stale version.
    const state=await service.syncNow();
    if(state.hasMore)throw Error("More remote changes remain; sync again before resolving");
    if(sharedCloud.currentUserId()!==ownerId)
      throw Error("Cloud account changed during conflict review");
    return service.resolveConflict(choice);
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
  mainWindow.on("closed", () => { focusGuard.close(); mainWindow = null; });
}

app.whenReady().then(async () => {
  if (userDataOverrideFailure) {
    dialog.showErrorBox(
      "无法打开自定义数据目录",
      "STUDY_ANCHOR_USER_DATA_DIR（兼容旧 ATE_USER_DATA_DIR）目录无效或两项设置冲突。程序不会自动切换到其他数据目录，请核对环境变量及目录权限。",
    );
    app.quit();
    return;
  }
  // Strictly BEFORE any store, diagnostic writer, vault or background sync.
  // If migration is ambiguous, stop rather than opening a new empty profile.
  try{
    await migrateStudyAnchorProfile({
      appData:app.getPath("appData"),
      destination:app.getPath("userData"),
      inPlace:customUserData,
    });
  }catch{
    dialog.showErrorBox("Study Anchor 数据迁移已暂停",
      "检测到无法安全迁移的旧数据或目标目录冲突。旧数据未被自动删除；请关闭旧版程序、备份用户数据目录，并按仓库迁移指南检查后重试。程序不会打开空白数据库覆盖现有资料。");
    app.quit();
    return;
  }
  diagnostics=new DiagnosticLogger(app.getPath("userData"));
  report("APP_START","app");
  if(sandboxDisabled)report("SANDBOX_DISABLED","app");
  try {
    // Back up older local schemas BEFORE the constructor runs migrations.
    await backupBeforeMigration(app.getPath("userData"),"study-anchor-tasks.sqlite",11);
    await backupBeforeMigration(app.getPath("userData"),"study-anchor-knowledge.sqlite",6);
    await backupBeforeMigration(app.getPath("userData"),"study-anchor-calendar.sqlite",5);
    await backupBeforeMigration(app.getPath("userData"),"study-anchor-planning.sqlite",2);
    store = new LocalStore(join(app.getPath("userData"), "study-anchor-tasks.sqlite"));
    knowledgeStore = new KnowledgeStore(join(app.getPath("userData"), "study-anchor-knowledge.sqlite"));
    // No downloads or cloud lookups. Optional models are restored only from
    // already verified assets in this application's private userData folder.
    offlineModels=new KnowledgeOfflineModels(app.getPath("userData"),knowledgeStore);
    await offlineModels.restore();
    fixedCalendarStore = new FixedCalendarStore(
      join(app.getPath("userData"),"study-anchor-calendar.sqlite"),
      ()=>planningStore?.listCommitted()??[],
      ()=>canvasSync?.scope()??null,
    );
    personalSync = new PersonalSyncService(sharedCloud,localStore(),fixedCalendar());
    // Optional file staging is independent of the five core SQLite stores.
    // No staged content is uploaded or read at application launch.
    try{
      personalFiles=new PersonalFileSyncService(sharedCloud,app.getPath("userData"));
    }catch{
      personalFiles=null;
      report("STORAGE_OPEN_FAILED","storage");
    }
    // The optional cloud history cache must never make offline tasks,
    // calendar, mail or knowledge unavailable if its file is damaged.
    try{
      // OS-backed encryption MUST exist before touching the optional cache.
      // v1/v2 plaintext records and in-progress snapshots are converted to
      // encrypted v3 in a single transaction. Prior backup copies can still
      // contain legacy plaintext and require separately reviewed disposal.
      const historyCipher=createTeamHistoryCipher(safeStorage);
      await backupBeforeMigration(app.getPath("userData"),
        "study-anchor-team-history.sqlite",3);
      workspaceHistoryStore=new WorkspaceHistoryStore(
        join(app.getPath("userData"),"study-anchor-team-history.sqlite"),historyCipher);
      workspaceHistoryService=new WorkspaceHistoryService(sharedCloud,workspaceHistoryStore);
    }catch{
      workspaceHistoryStore=null;workspaceHistoryService=null;
      report("STORAGE_OPEN_FAILED","storage");
      // Keep the file untouched. Cloud UI continues with RLS-backed 003A
      // latest-window refresh; old history pages remain disabled.
    }
    planningStore = new PlanningStore(join(app.getPath("userData"), "study-anchor-planning.sqlite"),
      ()=>fixedCalendar().busySlots());
    aiLedger = new AIUsageLedger(join(app.getPath("userData"), "study-anchor-ai-usage.sqlite"));
    aiService = new AIService(
      new AIKeyVault(join(app.getPath("userData"), "study-anchor-ai.enc"), safeStorage),
      aiLedger,
    );
    // An inaccessible old key does not block offline tasks or knowledge.
    await aiService.initialize().catch(()=>report("AI_INIT_DEGRADED","ai"));
    try{
      aiProjectStore=new AIProjectStore(join(app.getPath("userData"),"study-anchor-ai-projects.sqlite"));
      aiPlanning = new AIPlanningCoordinator(
        aiService,planningStore,()=>localStore().listTasks(),aiProjectStore,
      );
    }catch{
      aiProjectStore=null;aiPlanning=null;
      // A broken optional project registry must not block offline modules.
      report("STORAGE_OPEN_FAILED","storage");
    }
    canvasVault = new CanvasCredentialVault(join(app.getPath("userData"), "study-anchor-canvas.enc"), safeStorage);
    mailStore = new CampusMailStore(join(app.getPath("userData"), "study-anchor-mail.sqlite"));
    const mailVault = new CampusMailVault(join(app.getPath("userData"), "study-anchor-campus-mail.enc"), safeStorage);
    const mailDraftVault = new CampusMailDraftVault(join(app.getPath("userData"), "study-anchor-mail-drafts.enc"), safeStorage);
    mailService = new CampusMailService(mailVault, mailStore, undefined, undefined, () => {
      if(mailService?.snapshot().lastError)report("MAIL_SYNC_FAILED","mail");
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(MAIL_SYNC_UPDATED);
      }
    }, mailDraftVault);
    store.purgeExpiredHiddenCanvasTasks();
    canvasSync = new CanvasSyncService(store, async () => {
      const saved = await credentials().load();
      return saved ? new CanvasApi(saved.baseUrl, saved.token) : null;
    }, () => {
      const state=canvasSync?.snapshot();
      if(state?.lastError)report("CANVAS_SYNC_FAILED","canvas");
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CANVAS_SYNC_UPDATED);
      }
    },fixedCalendar());
  } catch (error) {
    // Never serialize raw SQLite errors, local paths, stacks, or input values.
    report("STORAGE_OPEN_FAILED","storage");
    await diagnostics?.flush();
    dialog.showErrorBox(
      "本地数据无法打开",
      "应用无法安全打开本地数据库。请备份用户数据目录后检查磁盘权限或数据库版本；应用不会自动覆盖已有数据。",
    );
    app.quit();
    return;
  }
  registerIpcHandlers();
  createWindow();
  report("APP_READY","app");
  coordinator().start(() => BrowserWindow.getAllWindows().length > 0);
  void coordinator().sync();
  campusMail().start(() => BrowserWindow.getAllWindows().length > 0);
  void campusMail().initialize().then(() => {
    if (mailService) void campusMail().sync().catch(()=>report("MAIL_SYNC_FAILED","mail"));
  }).catch(() => {
    // No credentials or OS encryption support: mail remains disconnected.
    report("MAIL_INIT_DEGRADED","mail");
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let waitingForPersonalSyncShutdown=false;
app.on("before-quit", (event) => {
  // Always relinquish focus-window elevation even if sync shutdown waits.
  focusGuard.close();
  const activePersonalSync=personalSync;
  if(activePersonalSync?.hasInFlightRun()){
    event.preventDefault();
    if(!waitingForPersonalSyncShutdown){
      waitingForPersonalSyncShutdown=true;
      activePersonalSync.cancel();
      void activePersonalSync.waitForIdle().finally(()=>{
        waitingForPersonalSyncShutdown=false;
        app.quit();
      });
    }
    return;
  }
  workspaceRealtime.stop();
  workspaceHistoryService?.cancel();
  workspaceHistoryService=null;
  workspaceHistoryStore?.close();workspaceHistoryStore=null;
  mailAIService?.cancel();
  mailAIService=null;
  mailService?.cancel();
  mailService?.stop();
  mailService = null;
  mailStore?.close();
  mailStore = null;
  canvasSync?.cancel();
  canvasSync?.stop();
  canvasSync = null;
  // Sync promises may be finishing; the coordinator aborts before further writes.
  aiPlanning?.cancel();
  aiService?.cancel();
  aiPlanning = null;
  aiProjectStore?.close();aiProjectStore=null;
  aiService = null;
  aiLedger?.close();
  aiLedger = null;
  pendingICS=null;
  personalSync=null;
  personalFiles?.close();personalFiles=null;
  planningStore?.close();
  planningStore = null;
  fixedCalendarStore?.close();
  fixedCalendarStore=null;
  offlineModels?.close();
  offlineModels=null;
  knowledgeStore?.close();
  knowledgeStore = null;
  store?.close();
  store = null;
});

app.on("window-all-closed", () => {
  // Configurable tray/background modes are a separate W5 system task.
  if (process.platform !== "darwin") app.quit();
});
