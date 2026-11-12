import { contextBridge, ipcRenderer } from "electron";

export interface SelectedBinaryFile {
  name: string;
  path: string;
  data: Uint8Array;
}

contextBridge.exposeInMainWorld("novelflow", {
  openEpubFiles: (): Promise<SelectedBinaryFile[]> => ipcRenderer.invoke("dialog:openEpubFiles"),
  openAudioFile: (): Promise<SelectedBinaryFile | null> => ipcRenderer.invoke("dialog:openAudioFile"),
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:toggleFullscreen"),
  setFullscreen: (flag: boolean): Promise<boolean> => ipcRenderer.invoke("window:setFullscreen", flag),
  getAppInfo: (): Promise<{ appVersion: string; isPackaged: boolean; backendUrl: string; platform: string }> =>
    ipcRenderer.invoke("app:getInfo"),
  getAiSetupInfo: (): Promise<{
    hasNvidiaGpu: boolean;
    gpuName: string | null;
    recommendedMode: "cuda" | "cpu";
    freeDiskGb: number;
    targetDir: string;
  }> => ipcRenderer.invoke("setup:getInfo"),
  startAiSetup: (mode: "cuda" | "cpu"): Promise<{ ok: boolean }> => ipcRenderer.invoke("setup:start", mode),
  cancelAiSetup: (): Promise<{ canceled: boolean }> => ipcRenderer.invoke("setup:cancel"),
  onAiSetupProgress: (
    cb: (evt: { stage?: string; percent?: number; log?: string; error?: string }) => void
  ): (() => void) => {
    const handler = (_e: unknown, payload: { stage?: string; percent?: number; log?: string; error?: string }) =>
      cb(payload);
    ipcRenderer.on("setup:progress", handler);
    return () => ipcRenderer.removeListener("setup:progress", handler);
  },
});

