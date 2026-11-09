import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isTrustedRendererUrl } from "../shared/renderer-trust";
import { LocalStore } from "./local-store";

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;

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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  store?.close();
  store = null;
});

app.on("window-all-closed", () => {
  // Configurable tray/background modes are a separate W5 system task.
  if (process.platform !== "darwin") app.quit();
});
