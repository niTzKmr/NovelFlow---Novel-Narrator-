"""Pydantic request and response schemas for NovelFlow backend APIs."""

from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


DevicePreference = Literal["auto", "cuda", "cpu"]
VoiceKind = Literal["preset", "designed_narrator", "cloned"]


class ModelCompatibility(BaseModel):
    fits_dedicated_vram: bool
    recommended_device: Literal["cuda", "cpu"]
    recommended_dtype: Literal["bfloat16", "float32"]
    recommended_batch_size: int
    warning: Optional[str] = None
    can_run_cpu_fallback: bool = True


class ModelInfo(BaseModel):
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
    is_downloaded: bool
    local_path: str
    is_active: bool = False
    active_device: Optional[str] = None
    active_dtype: Optional[str] = None
    compatibility: ModelCompatibility


class HardwareStatus(BaseModel):
    os_name: str
    os_version: str
    cpu_name: str
    cpu_cores_physical: int
    cpu_cores_logical: int
    ram_total_gb: float
    ram_available_gb: float
    cuda_available: bool
    gpu_name: Optional[str] = None
    vram_total_gb: float = 0.0
    vram_free_gb: float = 0.0
    bf16_supported: bool = False
    disk_free_gb: float
    ffmpeg_available: bool
    ffmpeg_path: Optional[str] = None


class ModelDownloadRequest(BaseModel):
    model_id: str


class ModelLoadRequest(BaseModel):
    model_id: str
    device: DevicePreference = "auto"
    allow_shared_vram_overflow: bool = False


class VoiceProfileOut(BaseModel):
    voice_id: str
    name: str
    kind: VoiceKind
    description: str
    narrator_style: Optional[str] = None
    instruct_prompt: Optional[str] = None
    speaker_name: Optional[str] = None
    ref_audio_path: Optional[str] = None
    ref_text: Optional[str] = None
    prompt_cache_path: Optional[str] = None
    sample_audio_url: Optional[str] = None
    compatible_models: list[str]
    is_builtin: bool
    is_preferred: bool
    consent_confirmed: bool = False
    created_at: str


class VoiceDesignCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(min_length=5, max_length=600)
    instruct: str = Field(min_length=10, max_length=1200)
    reference_text: Optional[str] = None
    device: DevicePreference = "auto"
    save_profile: bool = True


class VoiceCloneCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="Custom cloned voice profile", max_length=400)
    ref_text: str = Field(min_length=3, max_length=1200)
    consent_confirmed: bool
    x_vector_only_mode: bool = False


class LabGenerateRequest(BaseModel):
    voice_id: str
    model_id: str
    text: str = Field(min_length=1, max_length=1500)
    instruct: Optional[str] = None
    device: DevicePreference = "auto"
    language: str = "English"


class LabGenerateResponse(BaseModel):
    sample_id: str
    voice_id: str
    voice_name: str
    model_id: str
    device_used: str
    dtype_used: str
    audio_url: str
    audio_duration_sec: float
    generation_sec: float
    load_sec: float
    rtf: float
    peak_vram_mb: float
    ram_mb: float
    sample_rate: int
    instruct_applied: Optional[str] = None
    warning: Optional[str] = None


class SettingsUpdate(BaseModel):
    values: dict[str, Any]

