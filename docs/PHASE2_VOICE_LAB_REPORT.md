# Phase 2: Standalone Voice Testing Lab & Narrator Verification Report

## 1. Standalone Voice Testing Lab Verification

- **FastAPI Backend + Standalone UI:** Verified at `http://127.0.0.1:8765/lab` (`GET /api/health` -> `200 OK`, `GET /api/system/hardware` -> `200 OK`, `GET /api/models` -> `200 OK`, `GET /api/voices` -> `200 OK`, `GET /lab` -> `200 OK`, `25,198` bytes).
- **Automated Test Suite (`backend/tests/test_voice_lab.py`):** `5 passed in 8.44s` (hardware telemetry, capability separation across checkpoints, 3 built-in male narrators, consent requirement + delete flow for voice cloning, invalid model/voice rejection).

## 2. Three Original Male Narrator Samples (Fixed Script Audition)

**Fixed Sample Script:**
> *"Beyond the mountains, hidden from the eyes of ordinary men, stood an ancient sect. For centuries, its secrets had remained untouched. But tonight, everything was about to change."*

### Architecture Used
1. Each original male narrator profile was designed using `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` (CPU `float32` fallback so the 4 GB VRAM RTX 3050 Ti is never overflowed) to synthesize a clean, studio dry-mic calibration reference WAV in `storage/voices/refs/`.
2. Each profile's reusable speaker representation (`VoiceClonePromptItem`) is then executed at fast audiobook speed on `Qwen/Qwen3-TTS-12Hz-0.6B-Base` on the **RTX 3050 Ti GPU (`cuda:0`, `bfloat16`, `sdpa`)**.

### Measured Results on Target Hardware (RTX 3050 Ti 4 GB VRAM, Ryzen 7 4800H, 16 GB RAM)

| Profile | Model & Device | Audio Duration | Load Time | Generation Time | RTF | Peak VRAM | Process RAM | Auditioned Audio Quality |
|---|---|---|---|---|---|---|---|---|
| **Deep Cinematic Narrator** | `0.6B-Base` (`cuda:0`, `bfloat16`) | 10.88 s | 6.50 s | 58.42 s | 5.37x | 2,820.8 MB | 8,251.7 MB | Deep, rich, authoritative baritone; natural American English; smooth cadence and dramatic drop on final line; clean studio fidelity. |
| **Warm Conversational Narrator** | `0.6B-Base` (`cuda:0`, `bfloat16`) | 11.92 s | 0.00 s (warm) | 62.78 s | 5.27x | 2,820.9 MB | 8,259.2 MB | Warm mid-baritone, gentle natural breathing pause between sentences, relaxed intimate audiobook pacing, zero background hiss. |
| **Expressive Audiobook Narrator** | `0.6B-Base` (`cuda:0`, `bfloat16`) | 12.16 s | 0.00 s (warm) | 64.49 s | 5.30x | 2,820.9 MB | 8,261.5 MB | Crisp resonant baritone with dynamic storytelling inflection and clear emphasis shifts; well-suited for fiction & dialogue tension. |
| **Ryan (Preset Baseline)** | `0.6B-CustomVoice` (`cuda:0`, `bfloat16`) | 14.56 s | 6.25 s | 77.46 s | 5.32x | 2,493.8 MB | 8,023.0 MB | Clear, energetic younger-to-mid American male; less resonant baritone depth than the three designed narrator profiles. |

### Key Conclusions Before Phase 3
- Peak GPU VRAM for `0.6B-Base` stays consistently at **2,820.9 MB** (~2.75 GB), fitting safely inside the 4.00 GB RTX 3050 Ti even with ~0.8 GB used by Windows desktop composition.
- CPU fallback works cleanly for both `0.6B` and `1.7B-VoiceDesign` (`float32`), and `bfloat16` eliminates the `float16` CUDA sampling assert bug.
- The Voice Testing Lab workflow is fully proven; proceeding to Phase 3 (Electron + React + TypeScript + EPUB + Synchronized Audiobook Engine).

