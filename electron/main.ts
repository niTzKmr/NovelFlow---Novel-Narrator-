import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ChildProcess, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8765;
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let setupChild: ChildProcess | null = null;
let setupCanceled = false;
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

function getAiEnvPaths() {
  const aiEnvDir = path.join(app.getPath("userData"), "ai-env");
  return {
    aiEnvDir,
    aiEnvPython: path.join(aiEnvDir, "python.exe"),
    aiEnvMarker: path.join(aiEnvDir, ".setup-complete"),
    pythonBaseDir: path.join(process.resourcesPath || "", "python-base"),
    seedRefsDir: path.join(process.resourcesPath || "", "seed-refs"),
  };
}

function seedNarratorRefsIfNeeded(projectRoot: string): void {
  const { seedRefsDir } = getAiEnvPaths();
  if (!app.isPackaged || !fs.existsSync(seedRefsDir)) return;
  const targetRefsDir = path.join(projectRoot, "storage", "voices", "refs");
  fs.mkdirSync(targetRefsDir, { recursive: true });
  for (const name of fs.readdirSync(seedRefsDir)) {
    if (!name.toLowerCase().endsWith(".wav")) continue;
    const dst = path.join(targetRefsDir, name);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(seedRefsDir, name), dst);
    }
  }
}

function resolveBackendPaths(): { pythonExe: string; backendDir: string; projectRoot: string; needsSetup: boolean } {
  const devRoot = path.resolve(__dirname, "..");
  const devVenvPython = path.join(devRoot, "backend", ".venv", "Scripts", "python.exe");

  if (!app.isPackaged) {
    return {
      pythonExe: fs.existsSync(devVenvPython) ? devVenvPython : "python",
      backendDir: path.join(devRoot, "backend"),
      projectRoot: devRoot,
      needsSetup: false,
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
  const { aiEnvPython, aiEnvMarker, pythonBaseDir } = getAiEnvPaths();
  const bundledBaseExists = fs.existsSync(path.join(pythonBaseDir, "python.exe"));

  const readyAiPython = fs.existsSync(aiEnvMarker) && fs.existsSync(aiEnvPython) ? aiEnvPython : null;

  const candidates = [
    process.env.NOVELFLOW_PYTHON_EXE,
    portablePython,
    readyAiPython,
    path.join(exeDir, "backend", ".venv", "Scripts", "python.exe"),
    path.join(app.getPath("userData"), "venv", "Scripts", "python.exe"),
    workspaceVenvPython,
    devVenvPython,
  ].filter((p): p is string => Boolean(p));

  const foundPython = candidates.find((p) => fs.existsSync(p));
  const needsSetup = !foundPython && bundledBaseExists;
  const pythonExe = foundPython || "python";

  const hasPortableData = fs.existsSync(path.join(exeDir, "models")) || fs.existsSync(path.join(exeDir, "storage"));
  const projectRoot =
    process.env.NOVELFLOW_PROJECT_ROOT ||
    (hasPortableData
      ? exeDir
      : fs.existsSync(path.join(workspaceFallback, "models"))
      ? workspaceFallback
      : userDataRoot);
  return { pythonExe, backendDir: resBackend, projectRoot, needsSetup };
}

async function ensureBackendRunning(): Promise<void> {
  if (await checkBackendHealthy()) {
    return;
  }

  const { pythonExe, backendDir, projectRoot, needsSetup } = resolveBackendPaths();
  if (needsSetup) {
    return;
  }
  seedNarratorRefsIfNeeded(projectRoot);
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

function createWindow(pageFile: "index.html" | "setup.html" = "index.html"): void {
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
    mainWindow.loadURL(pageFile === "setup.html" ? "http://127.0.0.1:5173/setup.html" : "http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", pageFile));
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

function sendSetupProgress(payload: { stage?: string; percent?: number; log?: string; error?: string }) {
  mainWindow?.webContents.send("setup:progress", payload);
}

function runSetupStep(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    if (setupCanceled) {
      reject(new Error("Setup canceled by user."));
      return;
    }
    const child = spawn(exe, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    setupChild = child;
    const onData = (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split(/\r?\n/);
      for (const ln of lines) {
        const clean = ln.trim();
        if (clean) sendSetupProgress({ log: clean });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      setupChild = null;
      reject(err);
    });
    child.on("close", (code) => {
      setupChild = null;
      if (setupCanceled) {
        reject(new Error("Setup canceled by user."));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Installer command exited with code ${code}`));
      }
    });
  });
}

ipcMain.handle("setup:getInfo", async () => {
  let hasNvidiaGpu = false;
  let gpuName: string | null = null;
  if (process.platform === "win32") {
    try {
      const smi = execSync("nvidia-smi --query-gpu=name --format=csv,noheader", { timeout: 2500 }).toString().trim();
      if (smi) {
        hasNvidiaGpu = true;
        gpuName = smi.split(/\r?\n/)[0].trim();
      }
    } catch {
      try {
        const wmi = execSync(
          'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join \', \'"',
          { timeout: 3000 }
        )
          .toString()
          .trim();
        gpuName = wmi || null;
        if (wmi && wmi.toLowerCase().includes("nvidia")) {
          hasNvidiaGpu = true;
        }
      } catch {
        // ignore detection error
      }
    }
  }
  let freeDiskGb = 0;
  try {
    const targetPath = app.getPath("userData");
    fs.mkdirSync(targetPath, { recursive: true });
    const st = fs.statfsSync(targetPath);
    freeDiskGb = Number(((Number(st.bavail) * Number(st.bsize)) / 1024 ** 3).toFixed(1));
  } catch {
    freeDiskGb = 0;
  }
  return {
    hasNvidiaGpu,
    gpuName,
    recommendedMode: hasNvidiaGpu ? ("cuda" as const) : ("cpu" as const),
    freeDiskGb,
    targetDir: getAiEnvPaths().aiEnvDir,
  };
});

ipcMain.handle("setup:cancel", async () => {
  setupCanceled = true;
  if (setupChild?.pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(setupChild.pid), "/T", "/F"], { windowsHide: true });
    } else {
      setupChild.kill("SIGTERM");
    }
    setupChild = null;
  }
  return { canceled: true };
});

ipcMain.handle("setup:start", async (_evt, mode: "cuda" | "cpu", downloadDefaultModel = true) => {
  setupCanceled = false;
  const { aiEnvDir, aiEnvPython, aiEnvMarker, pythonBaseDir } = getAiEnvPaths();
  const reqFile = path.join(process.resourcesPath, "backend", "requirements.txt");

  try {
    if (!fs.existsSync(path.join(pythonBaseDir, "python.exe"))) {
      throw new Error(`Bundled Python runtime missing at ${pythonBaseDir}`);
    }
    if (fs.existsSync(aiEnvMarker)) {
      fs.unlinkSync(aiEnvMarker);
    }

    sendSetupProgress({ stage: "Preparing isolated Python 3.12 runtime...", percent: 8, log: `Target: ${aiEnvDir}` });
    fs.mkdirSync(aiEnvDir, { recursive: true });
    fs.cpSync(pythonBaseDir, aiEnvDir, { recursive: true, force: true });

    const pipEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONNOUSERSITE: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
    };

    sendSetupProgress({ stage: "Bootstrapping offline package installer (pip)...", percent: 18 });
    await runSetupStep(aiEnvPython, ["-s", "-m", "ensurepip", "--default-pip"], pipEnv);

    const torchIndex =
      mode === "cuda" ? "https://download.pytorch.org/whl/cu128" : "https://download.pytorch.org/whl/cpu";
    sendSetupProgress({
      stage: mode === "cuda" ? "Downloading PyTorch CUDA 12.8 (~2.6 GB)..." : "Downloading PyTorch CPU (~280 MB)...",
      percent: 32,
      log: `Installing torch & torchaudio from ${torchIndex}`,
    });
    await runSetupStep(
      aiEnvPython,
      ["-s", "-m", "pip", "install", "--no-cache-dir", "--upgrade", "torch==2.11.0", "torchaudio==2.11.0", "--index-url", torchIndex],
      pipEnv
    );

    sendSetupProgress({ stage: "Downloading Qwen3-TTS, FasterQwen3TTS & FastAPI backend...", percent: 72 });
    const reqArgs = ["-s", "-m", "pip", "install", "--no-cache-dir"];
    if (mode === "cuda") {
      reqArgs.push("--extra-index-url", "https://download.pytorch.org/whl/cu128");
    }
    reqArgs.push("-r", reqFile);
    await runSetupStep(aiEnvPython, reqArgs, pipEnv);

    sendSetupProgress({ stage: "Verifying installed AI packages...", percent: 76 });
    await runSetupStep(
      aiEnvPython,
      ["-s", "-c", "import torch, faster_qwen3_tts, qwen_tts, fastapi, uvicorn, soundfile, imageio_ffmpeg; print('OK')"],
      pipEnv
    );

    if (downloadDefaultModel !== false) {
      const { projectRoot } = resolveBackendPaths();
      const modelTarget = path.join(projectRoot, "models", "Qwen3-TTS-12Hz-0.6B-Base");
      const hfCache = path.join(projectRoot, "models", "hf_cache");
      fs.mkdirSync(modelTarget, { recursive: true });
      fs.mkdirSync(hfCache, { recursive: true });
      sendSetupProgress({
        stage: "Downloading default Qwen3-TTS-12Hz-0.6B-Base voice model (~2.34 GB)...",
        percent: 82,
        log: `Downloading into ${modelTarget}`,
      });
      await runSetupStep(
        aiEnvPython,
        [
          "-s",
          "-c",
          "import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id='Qwen/Qwen3-TTS-12Hz-0.6B-Base', local_dir=os.environ['NF_MODEL_DIR'])",
        ],
        { ...pipEnv, HF_HOME: hfCache, HF_HUB_DISABLE_SYMLINKS_WARNING: "1", NF_MODEL_DIR: modelTarget }
      );
    }

    fs.writeFileSync(
      aiEnvMarker,
      JSON.stringify({ mode, version: app.getVersion(), installedAt: new Date().toISOString() }, null, 2)
    );
    sendSetupProgress({ stage: "Starting local NovelFlow AI engine...", percent: 96 });

    await ensureBackendRunning();
    sendSetupProgress({ stage: "Ready!", percent: 100 });

    if (mainWindow) {
      if (process.env.NODE_ENV === "development") {
        await mainWindow.loadURL("http://127.0.0.1:5173");
      } else {
        await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
      }
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendSetupProgress({ error: msg });
    throw err;
  }
});

app.whenReady().then(async () => {
  const { needsSetup } = resolveBackendPaths();
  createWindow(needsSetup ? "setup.html" : "index.html");
  if (!needsSetup) {
    await ensureBackendRunning();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const check = resolveBackendPaths();
      createWindow(check.needsSetup ? "setup.html" : "index.html");
    }
  });
});

app.on("before-quit", () => {
  if (setupChild?.pid && process.platform === "win32") {
    spawn("taskkill", ["/PID", String(setupChild.pid), "/T", "/F"], { windowsHide: true });
  }
  stopBackendProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

