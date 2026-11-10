import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isTrustedRendererUrl } from "../shared/renderer-trust";
import { LocalStore } from "./local-store";
import { CanvasApi } from "./connectors/canvas-api";
import { CanvasCredentialVault } from "./connectors/canvas-credentials";
import { CanvasSyncService } from "./connectors/canvas-sync";
import { parseCanvasCourseId, parseCanvasPersonalTokenInput } from "../shared/canvas-model";

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let canvasVault: CanvasCredentialVault | null = null;
let canvasSync: CanvasSyncService | null = null;
const CANVAS_SYNC_UPDATED = "canvas:sync-updated";

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

app.whenReady().then(() => {
  try {
    store = new LocalStore(join(app.getPath("userData"), "ate-local.sqlite"));
    canvasVault = new CanvasCredentialVault(join(app.getPath("userData"), "canvas-personal.enc"), safeStorage);
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  canvasSync?.cancel();
  canvasSync?.stop();
  canvasSync = null;
  // Sync promises may be finishing; the coordinator aborts before further writes.
  store?.close();
  store = null;
});

app.on("window-all-closed", () => {
  // Configurable tray/background modes are a separate W5 system task.
  if (process.platform !== "darwin") app.quit();
});
