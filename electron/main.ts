import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8765;
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let spawnedByUs = false;

function checkBackendHealthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/api/health`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function resolveBackendPaths(): { pythonExe: string; backendDir: string; projectRoot: string } {
  const devRoot = path.resolve(__dirname, "..");
  const devVenvPython = path.join(devRoot, "backend", ".venv", "Scripts", "python.exe");

  if (!app.isPackaged) {
    return {
      pythonExe: fs.existsSync(devVenvPython) ? devVenvPython : "python",
      backendDir: path.join(devRoot, "backend"),
      projectRoot: devRoot,
    };
  }

  const resBackend = path.join(process.resourcesPath, "backend");
  const userDataRoot = path.join(app.getPath("userData"), "NovelFlowData");
  fs.mkdirSync(userDataRoot, { recursive: true });

  // Also check portable folder beside exe AND parent directories above packaged exe
  const exeDir = path.dirname(app.getPath("exe"));
  const workspaceFallback = path.resolve(exeDir, "..", "..");
  const portablePython = path.join(exeDir, "python-runtime", "python.exe");
  const workspaceVenvPython = path.join(workspaceFallback, "backend", ".venv", "Scripts", "python.exe");

  const candidates = [
    process.env.NOVELFLOW_PYTHON_EXE,
    portablePython,
    path.join(exeDir, "backend", ".venv", "Scripts", "python.exe"),
    path.join(app.getPath("userData"), "venv", "Scripts", "python.exe"),
    workspaceVenvPython,
    devVenvPython,
    "python",
  ].filter((p): p is string => Boolean(p));

  const pythonExe = candidates.find((p) => p === "python" || fs.existsSync(p)) || "python";
  const hasPortableData = fs.existsSync(path.join(exeDir, "models")) || fs.existsSync(path.join(exeDir, "storage"));
  const projectRoot =
    process.env.NOVELFLOW_PROJECT_ROOT ||
    (hasPortableData
      ? exeDir
      : fs.existsSync(path.join(workspaceFallback, "models"))
      ? workspaceFallback
      : userDataRoot);
  return { pythonExe, backendDir: resBackend, projectRoot };
}

async function ensureBackendRunning(): Promise<void> {
  if (await checkBackendHealthy()) {
    return;
  }

  const { pythonExe, backendDir, projectRoot } = resolveBackendPaths();
  const logPath = path.join(app.getPath("userData"), "novelflow-backend.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    `[${new Date().toISOString()}] Spawning backend: ${pythonExe} (cwd=${backendDir}, root=${projectRoot})\n`
  );

  spawnedByUs = true;
  backendProcess = spawn(
    pythonExe,
    ["-s", "-m", "uvicorn", "app.main:app", "--host", BACKEND_HOST, "--port", String(BACKEND_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        PYTHONPATH: backendDir,
        PYTHONNOUSERSITE: "1",
        NOVELFLOW_PROJECT_ROOT: projectRoot,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  backendProcess.on("error", (err) => {
    fs.appendFileSync(logPath, `[spawn-error] ${err.message}\n`);
  });
  backendProcess.stdout?.on("data", (d) => {
    fs.appendFileSync(logPath, d);
    process.stdout.write(`[backend] ${d}`);
  });
  backendProcess.stderr?.on("data", (d) => {
    fs.appendFileSync(logPath, d);
    process.stderr.write(`[backend] ${d}`);
  });

  for (let i = 0; i < 60; i += 1) {
    if (await checkBackendHealthy()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stopBackendProcess(): void {
  if (!spawnedByUs || !backendProcess || backendProcess.killed) {
    return;
  }
  const pid = backendProcess.pid;
  if (pid && process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    backendProcess.kill("SIGTERM");
  }
  backendProcess = null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "NovelFlow",
    backgroundColor: "#0f0f12",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("dialog:openEpubFiles", async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import EPUB Books",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "EPUB Books", extensions: ["epub"] }],
  });
  if (result.canceled) return [];
  return result.filePaths.map((fp) => ({
    name: path.basename(fp),
    path: fp,
    data: fs.readFileSync(fp),
  }));
});

ipcMain.handle("dialog:openAudioFile", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Reference Voice Recording",
    properties: ["openFile"],
    filters: [{ name: "Audio Files", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const fp = result.filePaths[0];
  return {
    name: path.basename(fp),
    path: fp,
    data: fs.readFileSync(fp),
  };
});

ipcMain.handle("window:toggleFullscreen", async () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

ipcMain.handle("window:setFullscreen", async (_evt, flag: boolean) => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(Boolean(flag));
  return mainWindow.isFullScreen();
});

ipcMain.handle("app:getInfo", async () => ({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  backendUrl: BACKEND_URL,
  platform: process.platform,
}));

app.whenReady().then(async () => {
  createWindow();
  await ensureBackendRunning();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopBackendProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

