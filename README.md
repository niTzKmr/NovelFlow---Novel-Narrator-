# NovelFlow — Free, Offline-First AI EPUB Reader & Audiobook Desktop Application

[![Download for Windows](https://img.shields.io/badge/Download_for_Windows-v1.0.0-blue?style=for-the-badge&logo=windows)](https://github.com/niTzKmr/NovelFlow---Novel-Narrator-/releases/download/v1.0.0/NovelFlow-Setup-1.0.0-x64.exe)
[![GitHub Release](https://img.shields.io/github/v/release/niTzKmr/NovelFlow---Novel-Narrator-?style=for-the-badge)](https://github.com/niTzKmr/NovelFlow---Novel-Narrator-/releases/latest)

> ### ⬇️ [Click Here to Download NovelFlow Setup v1.0.0 (Windows 64-bit)](https://github.com/niTzKmr/NovelFlow---Novel-Narrator-/releases/download/v1.0.0/NovelFlow-Setup-1.0.0-x64.exe)
> **File:** `NovelFlow-Setup-1.0.0-x64.exe` (96.6 MB)  
> **Self-Contained:** Automatically bootstraps the offline AI engine and voice models inside the app on first launch.

---

NovelFlow is a Windows desktop EPUB reader and local AI audiobook generator built with Electron, React, TypeScript, FastAPI, SQLite, and Alibaba's open-source **Qwen3-TTS** speech models. All narration runs locally on your GPU or CPU with zero cloud APIs, zero subscriptions, zero usage limits, and zero telemetry.

---

## Key Capabilities

- **Original Male Narrators & Voice Lab:**
  - Three built-in original baritone narrator profiles (**Deep Cinematic Narrator**, **Warm Conversational Narrator**, **Expressive Audiobook Narrator**) designed via `Qwen3-TTS-12Hz-1.7B-VoiceDesign` and executed locally on `Qwen3-TTS-12Hz-0.6B-Base` inside 4 GB VRAM (~2.82 GB peak VRAM on RTX 3050 Ti).
  - Built-in `CustomVoice` preset speakers (`Ryan`, `Aiden`, `Uncle_Fu`, etc.).
  - Natural-language **Voice Design** and local **Voice Cloning** (with explicit permission & rights confirmation).
  - Strict capability separation: runtime style instructions are only exposed for checkpoints that support them (`1.7B-CustomVoice` and `1.7B-VoiceDesign`), never silently faked on `0.6B-CustomVoice` or `Base`.
- **Hardware-Aware GPU & CPU Fallback:**
  - Automatic VRAM detection (`bfloat16` on Ampere+ CUDA GPUs, avoiding `float16` logit assertions) and clean CPU `float32` fallback for models exceeding 4 GB dedicated VRAM.
- **EPUB 2 & EPUB 3 Reader (`epub.js` + Synchronized Prose Engine):**
  - Drag-and-drop & file-picker import, automatic cover/metadata extraction, embedded images, italics/bold, Unicode & Chinese terminology support.
  - Chapter sidebar, in-book search, bookmarks, highlights & notes, customizable typography, themes (Charcoal, Dark, Sepia, Light, Custom), and fullscreen focus mode.
- **Synchronized Audiobook Playback & Persistent Caching:**
  - Sentence-level ground-truth audio timestamps (`len(wav) / sample_rate`), live active-sentence highlighting, auto-scrolling, click-any-sentence-to-narrate, paragraph & next-chapter auto-continuation, `0.75x`–`2.0x` playback speed, sleep timer, and deterministic disk caching (WAV / MP3 / AAC).
  - Single-worker background queue with priority jump, interruption recovery on restart, and optional next-chapter pre-generation.

---

## Prerequisites & Setup (Windows 10/11 64-bit)

- **Python 3.12** (64-bit)
- **Node.js 20+** (`npm`)
- **NVIDIA GPU with CUDA** (optional; 4 GB VRAM runs `0.6B-Base` & `0.6B-CustomVoice`; CPU fallback works on 16 GB RAM)

### 1. Python Backend Setup

```powershell
py -3.12 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install --upgrade pip
backend\.venv\Scripts\python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

### 2. Frontend & Electron Setup

```powershell
npm install
```

### 3. Run Standalone Voice Testing Lab

```powershell
.\scripts\run_voice_lab.ps1
# Open http://127.0.0.1:8765/lab
```

### 4. Run Full NovelFlow Desktop App (Development)

```powershell
npm run dev
```

### 5. Build Windows Installer (`release/NovelFlow-Setup-*.exe`)

```powershell
npm run dist:win
```

*(Packaged builds launch the local FastAPI backend using `NOVELFLOW_PYTHON_EXE`, an adjacent `backend\.venv\Scripts\python.exe`, or system Python 3.12.)*

---

## Running Tests

```powershell
$env:PYTHONPATH = "D:\EPUBReader\backend"
backend\.venv\Scripts\python.exe -m pytest backend\tests -v
npm run typecheck
```

---

## License

NovelFlow source code is MIT-compatible; all third-party libraries and Qwen3-TTS model licenses are documented in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md).

