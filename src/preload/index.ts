import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-channels";

const desktopApi = Object.freeze({
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.appPing) as Promise<{ ok: true }>,
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion) as Promise<string>,
});
contextBridge.exposeInMainWorld("desktop", desktopApi);
