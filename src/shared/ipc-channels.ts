export const IPC_CHANNELS = {
  appPing: "app:ping",
  appGetVersion: "app:get-version",
} as const;
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
