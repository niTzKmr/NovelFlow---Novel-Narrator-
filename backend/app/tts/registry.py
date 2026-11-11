"""Authoritative Qwen3-TTS model registry with exact hardware and capability metadata."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.core.config import settings


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    short_name: str
    display_name: str
    parameter_tier: Literal["0.6B", "1.7B"]
    architecture_mode: Literal["base", "custom_voice", "voice_design"]
    disk_size_gb: float
    min_vram_gb: float
    recommended_vram_gb: float
    license: str
    supports_preset_speakers: bool
    supports_instruct: bool
    supports_voice_design: bool
    supports_voice_clone: bool

    def local_path(self, models_dir: Path | None = None) -> Path:
        root = Path(models_dir or settings.models_dir)
        return root / self.short_name

    def is_downloaded(self, models_dir: Path | None = None) -> bool:
        p = self.local_path(models_dir)
        return (
            p.exists()
            and (p / "config.json").exists()
            and (p / "model.safetensors").exists()
            and (p / "speech_tokenizer" / "model.safetensors").exists()
        )


MODEL_SPECS: dict[str, ModelSpec] = {
    "Qwen/Qwen3-TTS-12Hz-0.6B-Base": ModelSpec(
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        short_name="Qwen3-TTS-12Hz-0.6B-Base",
        display_name="Qwen3-TTS 0.6B Base (Fast GPU Narration & Cloning)",
        parameter_tier="0.6B",
        architecture_mode="base",
        disk_size_gb=2.34,
        min_vram_gb=3.2,
        recommended_vram_gb=4.0,
        license="Apache-2.0",
        supports_preset_speakers=False,
        supports_instruct=False,
        supports_voice_design=False,
        supports_voice_clone=True,
    ),
    "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice": ModelSpec(
        model_id="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        short_name="Qwen3-TTS-12Hz-0.6B-CustomVoice",
        display_name="Qwen3-TTS 0.6B CustomVoice (9 Built-in Speakers)",
        parameter_tier="0.6B",
        architecture_mode="custom_voice",
        disk_size_gb=2.33,
        min_vram_gb=3.0,
        recommended_vram_gb=4.0,
        license="Apache-2.0",
        supports_preset_speakers=True,
        supports_instruct=False,  # Verified: qwen_tts disables instruct for 0b6
        supports_voice_design=False,
        supports_voice_clone=False,
    ),
    "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign": ModelSpec(
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        short_name="Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        display_name="Qwen3-TTS 1.7B VoiceDesign (Create Original Voices)",
        parameter_tier="1.7B",
        architecture_mode="voice_design",
        disk_size_gb=4.21,
        min_vram_gb=5.2,
        recommended_vram_gb=8.0,
        license="Apache-2.0",
        supports_preset_speakers=False,
        supports_instruct=True,
        supports_voice_design=True,
        supports_voice_clone=False,
    ),
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice": ModelSpec(
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        short_name="Qwen3-TTS-12Hz-1.7B-CustomVoice",
        display_name="Qwen3-TTS 1.7B CustomVoice (Preset Speakers + Style Control)",
        parameter_tier="1.7B",
        architecture_mode="custom_voice",
        disk_size_gb=4.21,
        min_vram_gb=5.2,
        recommended_vram_gb=8.0,
        license="Apache-2.0",
        supports_preset_speakers=True,
        supports_instruct=True,
        supports_voice_design=False,
        supports_voice_clone=False,
    ),
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base": ModelSpec(
        model_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        short_name="Qwen3-TTS-12Hz-1.7B-Base",
        display_name="Qwen3-TTS 1.7B Base (High-Capacity Voice Cloning)",
        parameter_tier="1.7B",
        architecture_mode="base",
        disk_size_gb=4.23,
        min_vram_gb=5.2,
        recommended_vram_gb=8.0,
        license="Apache-2.0",
        supports_preset_speakers=False,
        supports_instruct=False,
        supports_voice_design=False,
        supports_voice_clone=True,
    ),
}

PRESET_SPEAKERS: list[dict[str, str]] = [
    {"speaker": "Ryan", "name": "Ryan (Dynamic Male)", "native_language": "English", "description": "Dynamic English male voice with strong rhythmic drive and crisp articulation."},
    {"speaker": "Aiden", "name": "Aiden (Clear American Male)", "native_language": "English", "description": "Sunny American English male voice with a clear midrange."},
    {"speaker": "Uncle_Fu", "name": "Uncle Fu (Low Seasoned Male)", "native_language": "Chinese", "description": "Seasoned male voice with a low, mellow timbre (multilingual capable)."},
    {"speaker": "Dylan", "name": "Dylan (Beijing Male)", "native_language": "Chinese", "description": "Youthful male voice with a clear, natural timbre."},
    {"speaker": "Eric", "name": "Eric (Sichuan Male)", "native_language": "Chinese", "description": "Lively male voice with slightly husky brightness."},
    {"speaker": "Vivian", "name": "Vivian (Bright Female)", "native_language": "Chinese", "description": "Bright, slightly edgy young female voice."},
    {"speaker": "Serena", "name": "Serena (Warm Female)", "native_language": "Chinese", "description": "Warm, gentle young female voice."},
    {"speaker": "Ono_Anna", "name": "Ono Anna (Japanese Female)", "native_language": "Japanese", "description": "Playful Japanese female voice with a light, nimble timbre."},
    {"speaker": "Sohee", "name": "Sohee (Korean Female)", "native_language": "Korean", "description": "Warm Korean female voice with rich emotion."},
]


def get_model_spec(model_id: str) -> ModelSpec:
    if model_id not in MODEL_SPECS:
        raise ValueError(f"Unsupported model_id: {model_id}")
    return MODEL_SPECS[model_id]

