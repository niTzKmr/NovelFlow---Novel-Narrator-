"""Hardware-aware Qwen3-TTS inference (CUDA Graphs via FasterQwen3TTS + CPU fallback) and download manager."""

from __future__ import annotations

import gc
import hashlib
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
import psutil
import torch

from app.core.config import settings
from app.models.schemas import DevicePreference
from app.services.hardware import detect_hardware, evaluate_compatibility
from app.tts.registry import ModelSpec, get_model_spec


class HardwareCompatibilityError(RuntimeError):
    """Raised when a requested device/model configuration violates safe hardware limits."""


class ModelNotDownloadedError(FileNotFoundError):
    """Raised when a model is requested locally before its files have been downloaded."""


@dataclass
class SynthesisResult:
    wavs: list[np.ndarray]
    sample_rate: int
    model_id: str
    device_used: str
    dtype_used: str
    load_sec: float
    gen_sec: float
    audio_duration_sec: float
    rtf: float
    peak_vram_mb: float
    ram_mb: float
    warning: Optional[str] = None


def _compute_max_new_tokens(text: str, max_seq_len: int = 1280) -> int:
    """Bound max codec frames (~12Hz) safely proportional to text length so short lines never ramble."""
    budget = max(96, int(len(text) * 2.8) + 48)
    return min(max_seq_len - 256, budget)


class TTSEngine:
    """Thread-safe local Qwen3-TTS engine using FasterQwen3TTS CUDA Graphs on GPU and Qwen3TTSModel on CPU."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active_model: Any = None
        self._active_is_faster: bool = False
        self._active_spec: ModelSpec | None = None
        self._active_device: str | None = None
        self._active_dtype: str | None = None
        self._active_warning: str | None = None
        self._prompt_cache: dict[str, Any] = {}
        self._download_jobs: dict[str, dict[str, Any]] = {}
        self._max_seq_len: int = 1280

        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    def active_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "model_id": self._active_spec.model_id if self._active_spec else None,
                "device": self._active_device,
                "dtype": self._active_dtype,
                "cuda_graphs": self._active_is_faster,
                "warning": self._active_warning,
                "loaded": self._active_model is not None,
            }

    def unload(self) -> None:
        with self._lock:
            if self._active_model is not None:
                del self._active_model
                self._active_model = None
            self._active_is_faster = False
            self._active_spec = None
            self._active_device = None
            self._active_dtype = None
            self._active_warning = None
            self._prompt_cache.clear()
            gc.collect()
            if torch.cuda.is_available() and torch.cuda.is_initialized():
                torch.cuda.empty_cache()

    def _resolve_device_and_dtype(
        self,
        spec: ModelSpec,
        requested_device: DevicePreference,
        allow_shared_vram_overflow: bool = False,
    ) -> tuple[str, torch.dtype, str | None]:
        hw = detect_hardware()
        compat = evaluate_compatibility(spec, hw)

        if requested_device == "cpu":
            return "cpu", torch.float32, (
                None if compat.recommended_device == "cpu" else "Running on CPU as requested."
            )

        if requested_device == "cuda":
            if not hw.cuda_available:
                raise HardwareCompatibilityError("CUDA GPU was explicitly requested, but no CUDA GPU is available.")
            if not hw.bf16_supported:
                raise HardwareCompatibilityError(
                    f"GPU '{hw.gpu_name}' lacks native bfloat16 support; float16 causes CUDA numerical assertions in Qwen3-TTS."
                )
            if not compat.fits_dedicated_vram and not allow_shared_vram_overflow:
                raise HardwareCompatibilityError(
                    f"{spec.short_name} requires ~{spec.min_vram_gb:.1f} GB VRAM, exceeding your {hw.vram_total_gb:.1f} GB dedicated GPU. "
                    "Use CPU fallback or explicitly allow shared-VRAM overflow."
                )
            warn = None if compat.fits_dedicated_vram else compat.warning
            return "cuda:0", torch.bfloat16, warn

        if compat.recommended_device == "cuda":
            return "cuda:0", torch.bfloat16, compat.warning
        return "cpu", torch.float32, compat.warning

    def ensure_loaded(
        self,
        model_id: str,
        device: DevicePreference = "auto",
        allow_shared_vram_overflow: bool = False,
    ) -> tuple[Any, ModelSpec, float, str | None]:
        spec = get_model_spec(model_id)
        if not spec.is_downloaded():
            raise ModelNotDownloadedError(
                f"Model '{model_id}' is not downloaded locally at {spec.local_path()}. Download it first."
            )

        target_device, target_dtype, compat_warning = self._resolve_device_and_dtype(
            spec, device, allow_shared_vram_overflow=allow_shared_vram_overflow
        )
        dtype_name = "bfloat16" if target_dtype == torch.bfloat16 else "float32"

        with self._lock:
            if (
                self._active_model is not None
                and self._active_spec is not None
                and self._active_spec.model_id == model_id
                and self._active_device == target_device
                and self._active_dtype == dtype_name
            ):
                return self._active_model, spec, 0.0, self._active_warning

            self.unload()
            t0 = time.perf_counter()
            use_faster = False
            model: Any = None

            if target_device.startswith("cuda"):
                try:
                    from faster_qwen3_tts import FasterQwen3TTS

                    model = FasterQwen3TTS.from_pretrained(
                        str(spec.local_path()),
                        device=target_device,
                        dtype=target_dtype,
                        attn_implementation="sdpa",
                        max_seq_len=self._max_seq_len,
                        local_files_only=True,
                    )
                    model.warmup(prefill_len=160)
                    use_faster = True
                except Exception as exc:
                    if model is not None:
                        del model
                        gc.collect()
                        torch.cuda.empty_cache()
                    compat_warning = (
                        (compat_warning + " ") if compat_warning else ""
                    ) + f"CUDA graph acceleration unavailable ({type(exc).__name__}); using eager PyTorch CUDA."
                    model = None

            if model is None:
                from qwen_tts import Qwen3TTSModel

                model = Qwen3TTSModel.from_pretrained(
                    str(spec.local_path()),
                    device_map=target_device,
                    dtype=target_dtype,
                    attn_implementation="sdpa",
                    local_files_only=True,
                )

            load_sec = round(time.perf_counter() - t0, 3)
            self._active_model = model
            self._active_is_faster = use_faster
            self._active_spec = spec
            self._active_device = target_device
            self._active_dtype = dtype_name
            self._active_warning = compat_warning
            return model, spec, load_sec, compat_warning

    def preload_default_async(self, model_id: str, device: DevicePreference = "auto") -> None:
        """Warm up the default local GPU model in background at startup to eliminate first-click latency."""
        def _bg() -> None:
            try:
                spec = get_model_spec(model_id)
                hw = detect_hardware()
                compat = evaluate_compatibility(spec, hw)
                if spec.is_downloaded() and compat.recommended_device == "cuda":
                    self.ensure_loaded(model_id, device=device)
            except Exception:
                pass

        threading.Thread(target=_bg, name="novelflow-model-warmup", daemon=True).start()

    def _measure_resources(self) -> tuple[float, float]:
        ram_mb = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 1)
        peak_vram_mb = 0.0
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            peak_vram_mb = round(torch.cuda.max_memory_allocated(0) / (1024 * 1024), 1)
        return peak_vram_mb, ram_mb

    def _reset_vram_peak(self) -> None:
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            torch.cuda.reset_peak_memory_stats(0)

    def _get_or_build_clone_prompt(
        self,
        model: Any,
        spec: ModelSpec,
        ref_audio: str,
        ref_text: Optional[str],
        x_vector_only_mode: bool = False,
        prompt_cache_path: Optional[Path] = None,
    ) -> Any:
        key_src = f"{spec.model_id}|{ref_audio}|{ref_text or ''}|{x_vector_only_mode}"
        cache_key = hashlib.sha256(key_src.encode("utf-8")).hexdigest()[:24]
        if cache_key in self._prompt_cache:
            return self._prompt_cache[cache_key]

        base_qwen = model.model if self._active_is_faster else model

        if prompt_cache_path and prompt_cache_path.exists():
            try:
                items = torch.load(str(prompt_cache_path), map_location="cpu", weights_only=False)
                self._prompt_cache[cache_key] = items
                return items
            except Exception:
                pass

        items = base_qwen.create_voice_clone_prompt(
            ref_audio=ref_audio,
            ref_text=None if x_vector_only_mode else ref_text,
            x_vector_only_mode=x_vector_only_mode,
        )
        self._prompt_cache[cache_key] = items
        if prompt_cache_path:
            prompt_cache_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                torch.save(items, str(prompt_cache_path))
            except Exception:
                pass
        return items

    def synthesize_custom_voice(
        self,
        model_id: str,
        text: str | list[str],
        speaker: str | list[str],
        language: str | list[str] = "English",
        instruct: Optional[str | list[str]] = None,
        device: DevicePreference = "auto",
        allow_shared_vram_overflow: bool = False,
    ) -> SynthesisResult:
        with self._lock:
            model, spec, load_sec, warning = self.ensure_loaded(model_id, device, allow_shared_vram_overflow)
            if not spec.supports_preset_speakers:
                raise ValueError(f"Model {model_id} does not support preset CustomVoice speakers.")
            effective_instruct = instruct if spec.supports_instruct else None
            if instruct and not spec.supports_instruct:
                warning = (
                    (warning + " ") if warning else ""
                ) + f"{spec.short_name} does not support style instructions; instruction text was omitted."

            self._reset_vram_peak()
            t0 = time.perf_counter()

            if self._active_is_faster:
                texts = [text] if isinstance(text, str) else text
                speakers = [speaker] * len(texts) if isinstance(speaker, str) else speaker
                langs = [language] * len(texts) if isinstance(language, str) else language
                insts = (
                    [effective_instruct] * len(texts)
                    if not isinstance(effective_instruct, list)
                    else effective_instruct
                )
                wavs: list[np.ndarray] = []
                sr = 24000
                for t_item, spk_item, lang_item, ins_item in zip(texts, speakers, langs, insts):
                    w_list, sr = model.generate_custom_voice(
                        text=t_item,
                        speaker=spk_item,
                        language=lang_item,
                        instruct=ins_item,
                        non_streaming_mode=True,
                        max_new_tokens=_compute_max_new_tokens(t_item, self._max_seq_len),
                    )
                    wavs.append(w_list[0])
            else:
                wavs, sr = model.generate_custom_voice(
                    text=text,
                    speaker=speaker,
                    language=language,
                    instruct=effective_instruct,
                )

            if self._active_device and self._active_device.startswith("cuda"):
                torch.cuda.synchronize()
            gen_sec = round(time.perf_counter() - t0, 3)
            peak_vram_mb, ram_mb = self._measure_resources()
            total_dur = round(sum(len(w) / sr for w in wavs), 3)
            rtf = round(gen_sec / max(total_dur, 0.01), 3)
            return SynthesisResult(
                wavs=wavs,
                sample_rate=sr,
                model_id=model_id,
                device_used=self._active_device or "cpu",
                dtype_used=self._active_dtype or "float32",
                load_sec=load_sec,
                gen_sec=gen_sec,
                audio_duration_sec=total_dur,
                rtf=rtf,
                peak_vram_mb=peak_vram_mb,
                ram_mb=ram_mb,
                warning=warning,
            )

    def synthesize_voice_design(
        self,
        model_id: str,
        text: str | list[str],
        instruct: str | list[str],
        language: str | list[str] = "English",
        device: DevicePreference = "auto",
        allow_shared_vram_overflow: bool = False,
    ) -> SynthesisResult:
        with self._lock:
            model, spec, load_sec, warning = self.ensure_loaded(model_id, device, allow_shared_vram_overflow)
            if not spec.supports_voice_design:
                raise ValueError(f"Model {model_id} does not support natural-language VoiceDesign.")

            self._reset_vram_peak()
            t0 = time.perf_counter()

            if self._active_is_faster:
                texts = [text] if isinstance(text, str) else text
                insts = [instruct] * len(texts) if isinstance(instruct, str) else instruct
                langs = [language] * len(texts) if isinstance(language, str) else language
                wavs: list[np.ndarray] = []
                sr = 24000
                for t_item, ins_item, lang_item in zip(texts, insts, langs):
                    w_list, sr = model.generate_voice_design(
                        text=t_item,
                        instruct=ins_item,
                        language=lang_item,
                        non_streaming_mode=True,
                        max_new_tokens=_compute_max_new_tokens(t_item, self._max_seq_len),
                    )
                    wavs.append(w_list[0])
            else:
                wavs, sr = model.generate_voice_design(
                    text=text,
                    instruct=instruct,
                    language=language,
                )

            if self._active_device and self._active_device.startswith("cuda"):
                torch.cuda.synchronize()
            gen_sec = round(time.perf_counter() - t0, 3)
            peak_vram_mb, ram_mb = self._measure_resources()
            total_dur = round(sum(len(w) / sr for w in wavs), 3)
            rtf = round(gen_sec / max(total_dur, 0.01), 3)
            return SynthesisResult(
                wavs=wavs,
                sample_rate=sr,
                model_id=model_id,
                device_used=self._active_device or "cpu",
                dtype_used=self._active_dtype or "float32",
                load_sec=load_sec,
                gen_sec=gen_sec,
                audio_duration_sec=total_dur,
                rtf=rtf,
                peak_vram_mb=peak_vram_mb,
                ram_mb=ram_mb,
                warning=warning,
            )

    def synthesize_voice_clone(
        self,
        model_id: str,
        text: str | list[str],
        ref_audio: str,
        ref_text: Optional[str] = None,
        language: str | list[str] = "English",
        x_vector_only_mode: bool = False,
        prompt_cache_path: Optional[Path] = None,
        device: DevicePreference = "auto",
        allow_shared_vram_overflow: bool = False,
    ) -> SynthesisResult:
        with self._lock:
            model, spec, load_sec, warning = self.ensure_loaded(model_id, device, allow_shared_vram_overflow)
            if not spec.supports_voice_clone:
                raise ValueError(f"Model {model_id} does not support voice cloning.")

            prompt_items = self._get_or_build_clone_prompt(
                model=model,
                spec=spec,
                ref_audio=ref_audio,
                ref_text=ref_text,
                x_vector_only_mode=x_vector_only_mode,
                prompt_cache_path=prompt_cache_path,
            )

            self._reset_vram_peak()
            t0 = time.perf_counter()

            if self._active_is_faster:
                texts = [text] if isinstance(text, str) else text
                langs = [language] * len(texts) if isinstance(language, str) else language
                vcp_dict = model.model._prompt_items_to_voice_clone_prompt(prompt_items)
                eff_ref_text = (ref_text or (prompt_items[0].ref_text if prompt_items else "") or "").strip()
                wavs: list[np.ndarray] = []
                sr = 24000
                for t_item, lang_item in zip(texts, langs):
                    w_list, sr = model.generate_voice_clone(
                        text=t_item,
                        language=lang_item,
                        voice_clone_prompt=vcp_dict,
                        ref_text=eff_ref_text,
                        non_streaming_mode=True,
                        max_new_tokens=_compute_max_new_tokens(t_item, self._max_seq_len),
                    )
                    wavs.append(w_list[0])
            else:
                langs = [language] * len(text) if isinstance(text, list) and isinstance(language, str) else language
                wavs, sr = model.generate_voice_clone(
                    text=text,
                    language=langs,
                    voice_clone_prompt=prompt_items,
                    non_streaming_mode=True,
                )

            if self._active_device and self._active_device.startswith("cuda"):
                torch.cuda.synchronize()
            gen_sec = round(time.perf_counter() - t0, 3)
            peak_vram_mb, ram_mb = self._measure_resources()
            total_dur = round(sum(len(w) / sr for w in wavs), 3)
            rtf = round(gen_sec / max(total_dur, 0.01), 3)
            return SynthesisResult(
                wavs=wavs,
                sample_rate=sr,
                model_id=model_id,
                device_used=self._active_device or "cpu",
                dtype_used=self._active_dtype or "float32",
                load_sec=load_sec,
                gen_sec=gen_sec,
                audio_duration_sec=total_dur,
                rtf=rtf,
                peak_vram_mb=peak_vram_mb,
                ram_mb=ram_mb,
                warning=warning,
            )

    def start_download(self, model_id: str) -> dict[str, Any]:
        spec = get_model_spec(model_id)
        if spec.is_downloaded():
            return {"model_id": model_id, "status": "completed", "local_path": str(spec.local_path())}

        existing = self._download_jobs.get(model_id)
        if existing and existing["status"] == "downloading":
            return existing

        job = {
            "model_id": model_id,
            "status": "downloading",
            "local_path": str(spec.local_path()),
            "error": None,
        }
        self._download_jobs[model_id] = job

        def _worker() -> None:
            try:
                from huggingface_hub import snapshot_download
                from huggingface_hub.file_download import are_symlinks_supported

                cache_hub = settings.models_dir / "hf_cache" / "hub"
                cache_hub.mkdir(parents=True, exist_ok=True)
                are_symlinks_supported(str(cache_hub))

                snapshot_download(
                    repo_id=model_id,
                    local_dir=str(spec.local_path()),
                )
                job["status"] = "completed"
            except Exception as exc:
                job["status"] = "failed"
                job["error"] = f"{type(exc).__name__}: {exc}"

        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        return job

    def get_download_status(self, model_id: str) -> dict[str, Any]:
        spec = get_model_spec(model_id)
        if spec.is_downloaded():
            return {"model_id": model_id, "status": "completed", "local_path": str(spec.local_path()), "error": None}
        return self._download_jobs.get(
            model_id,
            {"model_id": model_id, "status": "not_downloaded", "local_path": str(spec.local_path()), "error": None},
        )


tts_engine = TTSEngine()
