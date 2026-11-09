/// <reference types="vite/client" />
interface Window {
  desktop: {
    ping: () => Promise<{ ok: true }>;
    getVersion: () => Promise<string>;
  };
}
