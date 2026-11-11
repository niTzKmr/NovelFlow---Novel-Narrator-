# Third-Party Licenses & Attribution — NovelFlow

NovelFlow is built exclusively with free and open-source software and locally running open-weight AI models. No paid cloud APIs, telemetry services, or proprietary TTS SDKs are used.

## 1. Local AI Models (Hugging Face / Qwen)

| Component | Source | License |
|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |
| `Qwen/Qwen3-TTS-Tokenizer-12Hz` | Alibaba Qwen Team (`QwenLM/Qwen3-TTS`) | Apache License 2.0 |

*Voice Ethics Notice:* Built-in narrator profiles (`Deep Cinematic Narrator`, `Warm Conversational Narrator`, `Expressive Audiobook Narrator`) are original synthetic voice profiles designed via `Qwen3-TTS-12Hz-1.7B-VoiceDesign`. User voice cloning requires explicit confirmation of speaker permission and legal rights.

## 2. Python Backend Dependencies (`backend/.venv`)

| Package | Version | License |
|---|---|---|
| `faster-qwen3-tts` | 0.5.4 | MIT |
| `qwen-tts-hf` | 0.1.1.post1 | Apache-2.0 |
| `torch` | 2.11.0+cu128 | BSD-3-Clause |
| `torchaudio` | 2.11.0+cu128 | BSD |
| `transformers` | 5.15.1 | Apache-2.0 |
| `accelerate` | 1.12.0 | Apache-2.0 |
| `fastapi` | 0.162.4 | MIT |
| `uvicorn` | 0.54.0 | BSD-3-Clause |
| `pydantic` | 2.14.3 | MIT |
| `soundfile` | 0.14.0 | BSD-3-Clause |
| `librosa` | 1.0.0 | ISC |
| `beautifulsoup4` | 4.15.0 | MIT |
| `lxml` | 6.1.3 | BSD-3-Clause |
| `psutil` | 7.2.2 | BSD-3-Clause |
| `onnxruntime` | 1.31.1 | MIT |
| `imageio-ffmpeg` | 0.8.1 | BSD-2-Clause (wrapper; bundles external `ffmpeg` binary) |
| `ffmpeg` (bundled subprocess CLI) | 9.0.2-essentials | GPLv3 (invoked only as an optional external subprocess for MP3/AAC cache transcoding; lossless WAV cache uses BSD-3 `soundfile` only) |

*(Note: AGPL-licensed `ebooklib` was deliberately excluded; EPUB 2 & EPUB 3 parsing is implemented directly in permissive pure Python via `zipfile`, `lxml`, and `beautifulsoup4`.)*

## 3. Desktop & Frontend Dependencies (`package.json`)

| Package | Version | License |
|---|---|---|
| `electron` | 34.5.8 | MIT |
| `react` / `react-dom` | 19.3.1 | MIT |
| `epubjs` | 0.3.93 | BSD-2-Clause |
| `framer-motion` | 12.43.0 | MIT |
| `lucide-react` | 0.475.0 | ISC |
| `zustand` | 5.1.0 | MIT |
| `tailwindcss` | 4.3.5 | MIT |
| `vite` | 6.4.6 | MIT |

