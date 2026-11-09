import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc-channels";

let mainWindow: BrowserWindow | null = null;

function isTrustedRendererUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === "file:" && url.pathname.endsWith("/index.html");
  } catch { return false; }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.appPing, (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) throw new Error("Untrusted IPC sender");
    return { ok: true as const };
  });
  ipcMain.handle(IPC_CHANNELS.appGetVersion, (event) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url ?? "")) throw new Error("Untrusted IPC sender");
    return app.getVersion();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360, height: 900, minWidth: 960, minHeight: 640, show: false,
    backgroundColor: "#f4f6fa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  // Tray residency and configurable background modes are scheduled for W5-6.
  if (process.platform !== "darwin") app.quit();
});
