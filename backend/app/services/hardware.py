"""Hardware detection and strict model compatibility checking."""

from __future__ import annotations

import functools
import platform
import shutil
import subprocess
from pathlib import Path

import psutil
import torch

from app.core.config import settings
from app.models.schemas import HardwareStatus, ModelCompatibility
from app.tts.registry import ModelSpec


@functools.lru_cache(maxsize=1)
def _detect_cpu_name() -> str:
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)"],
                text=True,
                timeout=3,
            ).strip()
            if out:
                return out
        except Exception:
            pass
    return platform.processor() or "Unknown CPU"


def _find_ffmpeg() -> tuple[bool, str | None]:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return True, system_ffmpeg
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return True, exe
    except Exception:
        pass
    return False, None


def detect_hardware() -> HardwareStatus:
    """Detect real CPU, RAM, CUDA GPU, VRAM, disk space, and FFmpeg availability."""
    vm = psutil.virtual_memory()
    disk = shutil.disk_usage(str(settings.project_root))
    cuda_ok = torch.cuda.is_available()

    gpu_name: str | None = None
    vram_total_gb = 0.0
    vram_free_gb = 0.0
    bf16_ok = False

    if cuda_ok:
        try:
            props = torch.cuda.get_device_properties(0)
            gpu_name = props.name
            vram_total_gb = round(props.total_memory / (1024 ** 3), 2)
            free_bytes, _ = torch.cuda.mem_get_info(0)
            vram_free_gb = round(free_bytes / (1024 ** 3), 2)
            bf16_ok = bool(torch.cuda.is_bf16_supported())
        except Exception:
            cuda_ok = False

    ffmpeg_ok, ffmpeg_path = _find_ffmpeg()
    return HardwareStatus(
        os_name=platform.system(),
        os_version=platform.version(),
        cpu_name=_detect_cpu_name(),
        cpu_cores_physical=psutil.cpu_count(logical=False) or 1,
        cpu_cores_logical=psutil.cpu_count(logical=True) or 1,
        ram_total_gb=round(vm.total / (1024 ** 3), 2),
        ram_available_gb=round(vm.available / (1024 ** 3), 2),
        cuda_available=cuda_ok,
        gpu_name=gpu_name,
        vram_total_gb=vram_total_gb,
        vram_free_gb=vram_free_gb,
        bf16_supported=bf16_ok,
        disk_free_gb=round(disk.free / (1024 ** 3), 2),
        ffmpeg_available=ffmpeg_ok,
        ffmpeg_path=ffmpeg_path,
    )


def evaluate_compatibility(spec: ModelSpec, hw: HardwareStatus) -> ModelCompatibility:
    """Assess whether a checkpoint safely fits in dedicated VRAM or needs CPU fallback."""
    if not hw.cuda_available:
        return ModelCompatibility(
            fits_dedicated_vram=False,
            recommended_device="cpu",
            recommended_dtype="float32",
            recommended_batch_size=1,
            warning="No CUDA GPU detected; using CPU fallback (slower generation).",
            can_run_cpu_fallback=hw.ram_total_gb >= (8.0 if spec.parameter_tier == "0.6B" else 12.0),
        )

    if not hw.bf16_supported:
        return ModelCompatibility(
            fits_dedicated_vram=False,
            recommended_device="cpu",
            recommended_dtype="float32",
            recommended_batch_size=1,
            warning=(
                f"GPU '{hw.gpu_name}' lacks native bfloat16 support, and float16 overflows in Qwen3-TTS. "
                "Using CPU float32 for numerical stability."
            ),
            can_run_cpu_fallback=True,
        )

    fits_vram = hw.vram_total_gb >= spec.min_vram_gb
    if fits_vram:
        rec_batch = 2 if hw.vram_total_gb >= 6.0 else 1
        if hw.vram_total_gb >= 8.0:
            rec_batch = 4
        return ModelCompatibility(
            fits_dedicated_vram=True,
            recommended_device="cuda",
            recommended_dtype="bfloat16",
            recommended_batch_size=rec_batch,
            warning=None,
            can_run_cpu_fallback=True,
        )

    return ModelCompatibility(
        fits_dedicated_vram=False,
        recommended_device="cpu",
        recommended_dtype="float32",
        recommended_batch_size=1,
        warning=(
            f"{spec.short_name} requires ~{spec.min_vram_gb:.1f} GB VRAM, exceeding your "
            f"{hw.vram_total_gb:.1f} GB dedicated GPU memory ({hw.gpu_name}). "
            "Auto mode uses CPU fallback to prevent CUDA OOM / shared-VRAM thrashing."
        ),
        can_run_cpu_fallback=hw.ram_total_gb >= 12.0,
    )
