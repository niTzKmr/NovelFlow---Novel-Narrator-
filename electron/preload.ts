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
});

