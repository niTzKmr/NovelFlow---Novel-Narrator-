"""Hardware compatibility and generation benchmark for Qwen3-TTS models.

Tests load behavior, VRAM/RAM consumption, generation speed, RTF, and audio metrics
across GPU (CUDA bfloat16/float16) and CPU fallback for Qwen3-TTS variants.
"""

from __future__ import annotations

import gc
import json
import os
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HOME", r"D:\EPUBReader\models\hf_cache")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np
import psutil
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

SAMPLE_SCRIPT = (
    "Beyond the mountains, hidden from the eyes of ordinary men, stood an ancient sect. "
    "For centuries, its secrets had remained untouched. But tonight, everything was about to change."
)

OUT_DIR = Path(r"D:\EPUBReader\storage\voices\lab_benchmarks")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def get_ram_mb() -> float:
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def get_gpu_mem_mb() -> dict[str, float]:
    if not torch.cuda.is_available() or not torch.cuda.is_initialized():
        return {"allocated_mb": 0.0, "reserved_mb": 0.0, "peak_allocated_mb": 0.0, "peak_reserved_mb": 0.0}
    return {
        "allocated_mb": round(torch.cuda.memory_allocated(0) / (1024 * 1024), 1),
        "reserved_mb": round(torch.cuda.memory_reserved(0) / (1024 * 1024), 1),
        "peak_allocated_mb": round(torch.cuda.max_memory_allocated(0) / (1024 * 1024), 1),
        "peak_reserved_mb": round(torch.cuda.max_memory_reserved(0) / (1024 * 1024), 1),
    }


def cleanup(model: Any = None) -> None:
    if model is not None:
        del model
    gc.collect()
    if torch.cuda.is_available() and torch.cuda.is_initialized():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(0)


def audio_metrics(wav: np.ndarray, sr: int) -> dict[str, Any]:
    duration = float(len(wav)) / float(sr)
    rms = float(np.sqrt(np.mean(np.square(wav.astype(np.float64)))))
    peak = float(np.max(np.abs(wav)))
    return {
        "sample_rate": sr,
        "duration_sec": round(duration, 2),
        "rms": round(rms, 4),
        "peak": round(peak, 4),
        "non_silent": bool(rms > 0.005 and duration > 0.5),
    }


MODELS_DIR = Path(r"D:\EPUBReader\models")


def resolve_model_path(repo_id: str) -> str:
    short_name = repo_id.split("/")[-1]
    local_dir = MODELS_DIR / short_name
    return str(local_dir) if local_dir.exists() else repo_id


def run_case(name: str, model_id: str, device_map: str, dtype: torch.dtype, mode: str, **gen_args) -> dict[str, Any]:
    resolved_path = resolve_model_path(model_id)
    print(f"\n=== Running: {name} ({resolved_path} | device={device_map} | dtype={dtype}) ===", flush=True)
    cleanup()
    ram_before = get_ram_mb()
    t0 = time.perf_counter()
    model = None
    try:
        model = Qwen3TTSModel.from_pretrained(
            resolved_path,
            device_map=device_map,
            dtype=dtype,
            attn_implementation="sdpa",
            local_files_only=True,
        )
        load_sec = time.perf_counter() - t0
        ram_after_load = get_ram_mb()
        gpu_after_load = get_gpu_mem_mb()

        t_gen = time.perf_counter()
        if mode == "custom_voice":
            wavs, sr = model.generate_custom_voice(**gen_args)
        elif mode == "voice_design":
            wavs, sr = model.generate_voice_design(**gen_args)
        elif mode == "voice_clone":
            wavs, sr = model.generate_voice_clone(**gen_args)
        else:
            raise ValueError(mode)
        gen_sec = time.perf_counter() - t_gen
        gpu_after_gen = get_gpu_mem_mb()
        ram_after_gen = get_ram_mb()

        out_path = OUT_DIR / f"{name}.wav"
        sf.write(str(out_path), wavs[0], sr)
        metrics = audio_metrics(wavs[0], sr)
        rtf = round(gen_sec / max(metrics["duration_sec"], 0.01), 3)

        result = {
            "name": name,
            "status": "ok",
            "model_id": model_id,
            "device_map": device_map,
            "dtype": str(dtype),
            "load_sec": round(load_sec, 2),
            "gen_sec": round(gen_sec, 2),
            "rtf": rtf,
            "ram_delta_mb": round(ram_after_gen - ram_before, 1),
            "ram_total_mb": round(ram_after_gen, 1),
            "gpu_after_load": gpu_after_load,
            "gpu_after_gen": gpu_after_gen,
            "audio": metrics,
            "wav_path": str(out_path),
            "supported_speakers": model.get_supported_speakers(),
        }
        print(json.dumps(result, indent=2), flush=True)
        return result
    except Exception as exc:
        err = {
            "name": name,
            "status": "error",
            "model_id": model_id,
            "device_map": device_map,
            "dtype": str(dtype),
            "error": f"{type(exc).__name__}: {exc}",
            "gpu_mem": get_gpu_mem_mb(),
        }
        print(json.dumps(err, indent=2), flush=True)
        return err
    finally:
        cleanup(model)


def main() -> None:
    results = []

    # 1. Test 0.6B-CustomVoice on GPU (CUDA bfloat16)
    results.append(
        run_case(
            "06b_custom_ryan_gpu",
            "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            "cuda:0",
            torch.bfloat16,
            "custom_voice",
            text=SAMPLE_SCRIPT,
            language="English",
            speaker="Ryan",
        )
    )

    # 2. Test 0.6B-CustomVoice on CPU fallback (float32)
    results.append(
        run_case(
            "06b_custom_aiden_cpu",
            "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            "cpu",
            torch.float32,
            "custom_voice",
            text=SAMPLE_SCRIPT,
            language="English",
            speaker="Aiden",
        )
    )

    # 3. Test 1.7B-VoiceDesign on GPU vs CPU to check 4GB VRAM fit!
    narrator_instruct = (
        "A mature adult male audiobook narrator with a deep, rich, warm baritone voice. "
        "Natural American English accent, clear articulation, realistic breathing and phrasing, "
        "controlled vocal dynamics, subtle emotional expression, conversational delivery, "
        "and smooth transitions between sentences."
    )
    results.append(
        run_case(
            "17b_voicedesign_gpu_bf16",
            "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
            "cuda:0",
            torch.bfloat16,
            "voice_design",
            text=SAMPLE_SCRIPT,
            language="English",
            instruct=narrator_instruct,
        )
    )

    # 4. Also test 1.7B-VoiceDesign on CPU (bfloat16 / float32)
    results.append(
        run_case(
            "17b_voicedesign_cpu_f32",
            "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
            "cpu",
            torch.float32,
            "voice_design",
            text=SAMPLE_SCRIPT,
            language="English",
            instruct=narrator_instruct,
        )
    )

    # 5. Test 0.6B-Base voice clone on GPU using the designed voice clip if available
    ref_wav = OUT_DIR / "17b_voicedesign_cpu_f32.wav"
    if not ref_wav.exists():
        ref_wav = OUT_DIR / "17b_voicedesign_gpu_bf16.wav"
    if ref_wav.exists():
        results.append(
            run_case(
                "06b_base_clone_gpu_bf16",
                "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                "cuda:0",
                torch.bfloat16,
                "voice_clone",
                text=SAMPLE_SCRIPT,
                language="English",
                ref_audio=str(ref_wav),
                ref_text=SAMPLE_SCRIPT,
            )
        )

    summary_path = OUT_DIR / "benchmark_results.json"
    summary_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nSaved full benchmark summary to {summary_path}")


if __name__ == "__main__":
    main()

