# NovelFlow Local Models Directory

All AI text-to-speech weights are stored locally in `models/hf_cache` (via `HF_HOME`) so NovelFlow operates **100% offline** after initial download, with zero cloud APIs, zero subscriptions, and zero usage limits.

## Evaluated Qwen3-TTS Model Variants

All official Qwen3-TTS 12Hz checkpoints and the `Qwen/Qwen3-TTS-Tokenizer-12Hz` codec are licensed under **Apache License 2.0** (verified via Hugging Face model metadata and `QwenLM/Qwen3-TTS` repository `LICENSE`).

| Model ID | Disk Size | License | Supported Capabilities | Target Hardware Notes (4 GB VRAM RTX 3050 Ti) |
|---|---|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | ~2.34 GB | Apache-2.0 | Zero-shot voice cloning (`generate_voice_clone`, `create_voice_clone_prompt`) | Fits in 4 GB VRAM (`bfloat16`/`float16`) — primary fast GPU narration engine for cloned & designed narrator profiles |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | ~2.33 GB | Apache-2.0 | 9 preset speakers (`Ryan`, `Aiden`, `Uncle_Fu`, `Dylan`, `Eric`, `Vivian`, `Serena`, `Ono_Anna`, `Sohee`); no `instruct` control | Fits in 4 GB VRAM (`bfloat16`/`float16`) — fast GPU preset voices |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | ~4.21 GB | Apache-2.0 | Natural-language voice creation (`generate_voice_design` with `instruct`) | Exceeds 4 GB dedicated VRAM; runs via CPU fallback or GPU/CPU hybrid where supported — ideal for one-time narrator profile design |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | ~4.21 GB | Apache-2.0 | 9 preset speakers + style `instruct` control | Exceeds 4 GB dedicated VRAM (recommended >= 6–8 GB VRAM); CPU fallback available |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | ~4.23 GB | Apache-2.0 | High-capacity zero-shot voice cloning | Exceeds 4 GB dedicated VRAM (recommended >= 6–8 GB VRAM); CPU fallback available |

## Capability Matrix (Never Conflated)

NovelFlow exposes **only** the modes supported by the active checkpoint:
- **Preset Voices (`CustomVoice`)**: Built-in speaker timbres (`Ryan`, `Aiden`, etc.). Style `instruct` is exposed **only** on `1.7B-CustomVoice` (disabled on `0.6B-CustomVoice` because `qwen_tts` ignores `instruct` on `0b6`).
- **Voice Design (`VoiceDesign`)**: Synthesize original voices from natural-language descriptions (`1.7B-VoiceDesign`), then optionally save the resulting reference clip as a reusable **Narrator Voice Profile** for fast GPU synthesis via `Base`.
- **Voice Cloning (`Base`)**: Synthesize narration from an authorized local reference WAV + transcript (`create_voice_clone_prompt` / `generate_voice_clone`).

