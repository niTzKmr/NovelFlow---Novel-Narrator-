# Phase 1: System Research, Hardware Compatibility & License Verification

## 1. Inspected Target System

- **OS:** Microsoft Windows 11 Home Single Language (64-bit, Build 26200)
- **CPU:** AMD Ryzen 7 4800H with Radeon Graphics (8 cores / 16 logical processors)
- **System RAM:** 15,791 MB (~16 GB)
- **GPU:** NVIDIA GeForce RTX 3050 Ti Laptop GPU — 4,096 MiB (4.00 GB) dedicated VRAM, Driver 610.62, CUDA UMD 13.3, Compute Capability SM 8.6 (Ampere, native `bfloat16` supported)
- **Python Runtime:** Python 3.12.10 (64-bit) in isolated virtual environment (`D:\EPUBReader\backend\.venv`)
- **Node.js Runtime:** v24.16.0 (`npm` 11.6.0)
- **Storage Layout:** System drive `C:` (~18.3 GB free); project workspace drive `D:\EPUBReader` (~518.8 GB free). All virtual environments, model weights, caches, books, and generated audio are stored on `D:\EPUBReader` to keep `C:` clean and ensure full offline portability.

## 2. Qwen3-TTS Architecture & Official Variant Matrix

Verified directly against `QwenLM/Qwen3-TTS` (`README.md`, `pyproject.toml`) and the installed `qwen-tts==0.1.1` package (`qwen_tts/inference/qwen3_tts_model.py`, `qwen_tts/core/models/modeling_qwen3_tts.py`):

| Model Checkpoint | Disk Size | License | Supported Mode(s) | Instruction Control (`instruct`) | Verified Fit on 4 GB RTX 3050 Ti |
|---|---|---|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 2.34 GB | Apache-2.0 | Voice Cloning (`create_voice_clone_prompt`, `generate_voice_clone`) | No | **Fits CUDA (`bfloat16`)** — 2,083 MB load, 2,823 MB peak allocated (3,102 MB reserved) |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | 2.33 GB | Apache-2.0 | 9 Preset Speakers (`generate_custom_voice`) | **No** (explicitly nulled in `qwen3_tts_model.py` line 799 for `0b6`) | **Fits CUDA (`bfloat16`)** — 2,057 MB load, 2,497 MB peak allocated (2,826 MB reserved) |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | 4.21 GB | Apache-2.0 | Natural-Language Voice Design (`generate_voice_design`) | **Yes** | **Exceeds 4 GB dedicated VRAM** (4,000 MB load, 4,388 MB peak allocated / 4,680 MB reserved -> spills into Windows shared VRAM). Runs cleanly on **CPU (`float32`)** (9.18 GB peak RSS RAM) |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 4.21 GB | Apache-2.0 | 9 Preset Speakers + Style Instructions | **Yes** | Exceeds 4 GB dedicated VRAM (recommended >= 6–8 GB VRAM); CPU fallback supported |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 4.23 GB | Apache-2.0 | Zero-shot Voice Cloning | No | Exceeds 4 GB dedicated VRAM (recommended >= 6–8 GB VRAM); CPU fallback supported |

## 3. Critical Empirical Engineering Findings

1. **`bfloat16` Required on CUDA (Never `float16`):**
   Testing `0.6B-CustomVoice` on CUDA with `torch.float16` triggered `TensorCompare.cu:109 Assertion input[0] != 0 failed` (`CUDA error: device-side assert triggered`) due to fp16 logit overflow/NaN in autoregressive sampling. Native `torch.bfloat16` (supported on Ampere RTX 3050 Ti) executes cleanly without errors. On pre-Ampere GPUs lacking `bfloat16` support, NovelFlow falls back to `float32` / CPU rather than risking `float16` instability.
2. **`0.6B-CustomVoice` Does Not Support `instruct`:**
   In `qwen3_tts_model.py`, `tts_model_size in "0b6"` explicitly sets `instruct = None`. NovelFlow never exposes style instruction controls when `0.6B-CustomVoice` is active.
3. **SoX Warning vs. 12Hz Models:**
   `qwen_tts` imports Python `sox` inside `core/tokenizer_25hz/vq/speech_vq.py`, emitting a harmless startup warning if `sox.exe` is absent on Windows `PATH`. The 12Hz tokenizer and models do **not** call `sox.exe`; they use `soundfile`, `librosa`, and `torchaudio` directly. FFmpeg is bundled locally via `imageio-ffmpeg` for optional MP3/AAC caching.
4. **Windows `huggingface_hub` Multi-Thread Symlink Race (`[WinError 1314]`):**
   `huggingface_hub.file_download.are_symlinks_supported()` caches `_are_symlinks_supported_in_dir[cache_dir] = True` *before* testing `os.symlink()`, creating a race condition under `snapshot_download`'s thread pool on Windows without Developer Mode. NovelFlow avoids this completely by warming `are_symlinks_supported()` synchronously on the main thread and downloading directly to `models/<model_name>` via `local_dir`.
5. **Recommended Hybrid Local Architecture for 4 GB VRAM:**
   - **Voice Creation (`1.7B-VoiceDesign` on CPU fallback or >=8 GB GPU):** Generates studio-clean reusable male baritone narrator reference clips from natural-language voice descriptions.
   - **Primary Audiobook Narration (`0.6B-Base` on RTX 3050 Ti GPU in `bfloat16`):** Extracts and caches `VoiceClonePromptItem` tensors once per narrator profile (1.57 s), then synthesizes long-form chapters entirely within ~2.8 GB VRAM (batch size 1).
   - **Preset Fast Voices (`0.6B-CustomVoice` on RTX 3050 Ti GPU in `bfloat16`):** Immediate access to built-in speakers (`Ryan`, `Aiden`, `Uncle_Fu`, etc.) within ~2.5 GB VRAM.
   - **Batch Size vs. VRAM Trade-off:** `batch_size=1` keeps peak VRAM at ~2.82 GB (~5.24x RTF); `batch_size=4` lowers RTF to 2.71x but spikes peak VRAM to 4.87 GB (overflowing 4 GB). NovelFlow defaults to `batch_size=1` on <= 5 GB VRAM GPUs and makes batch size configurable in Performance settings.

## 4. License & Free/OSS Verification

- **Qwen3-TTS Code & Checkpoints (`QwenLM/Qwen3-TTS`, all 5 variants + `Tokenizer-12Hz`):** Apache-2.0
- **Backend Stack:** FastAPI (MIT), Uvicorn (BSD-3), PyTorch (BSD-3), Transformers (Apache-2.0), SoundFile (BSD-3), EbookLib (AGPL-3.0 — note: check EbookLib license carefully! Let's review EbookLib vs pure Python `zipfile` + `xml.etree` / `lxml` EPUB parser!).

> **License Note on EbookLib:** EbookLib is AGPL-3.0 licensed. For maximum permissive compatibility (MIT/Apache/BSD preference per Section 14), NovelFlow implements its own clean, lightweight EPUB 2 & EPUB 3 parser in Python using standard library `zipfile` + `lxml` (BSD-3) + `beautifulsoup4` (MIT), avoiding AGPL copyleft constraints while giving full control over malformed/webnovel EPUB recovery!

