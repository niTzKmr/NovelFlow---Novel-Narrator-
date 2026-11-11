"""Core FastAPI routes for NovelFlow (Hardware, Models, Voices, Voice Lab, Settings)."""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Optional

import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.config import settings
from app.database.db import get_all_settings, get_db, set_setting
from app.models.schemas import (
    HardwareStatus,
    LabGenerateRequest,
    LabGenerateResponse,
    ModelDownloadRequest,
    ModelInfo,
    ModelLoadRequest,
    SettingsUpdate,
    VoiceDesignCreateRequest,
    VoiceProfileOut,
)
from app.services.hardware import detect_hardware, evaluate_compatibility
from app.services.voices import (
    CALIBRATION_PASSAGE,
    create_cloned_voice_profile,
    create_designed_voice_profile,
    delete_voice,
    ensure_narrator_reference_clip,
    get_voice,
    list_voices,
    set_preferred_voice,
)
from app.tts.engine import HardwareCompatibilityError, ModelNotDownloadedError, tts_engine
from app.tts.registry import MODEL_SPECS, get_model_spec


router = APIRouter(prefix="/api", tags=["novelflow"])

FIXED_SAMPLE_SCRIPT = (
    "Beyond the mountains, hidden from the eyes of ordinary men, stood an ancient sect. "
    "For centuries, its secrets had remained untouched. But tonight, everything was about to change."
)


def _lab_dir() -> Path:
    d = settings.voices_dir / "lab_samples"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.app_version,
        "local_only": settings.local_only_mode,
        "telemetry_enabled": settings.telemetry_enabled,
        "active_engine": tts_engine.active_state(),
    }


@router.get("/system/hardware", response_model=HardwareStatus)
def system_hardware() -> HardwareStatus:
    return detect_hardware()


@router.get("/models", response_model=list[ModelInfo])
def list_models() -> list[ModelInfo]:
    hw = detect_hardware()
    active = tts_engine.active_state()
    out: list[ModelInfo] = []
    for spec in MODEL_SPECS.values():
        is_active = active["model_id"] == spec.model_id and active["loaded"]
        out.append(
            ModelInfo(
                model_id=spec.model_id,
                short_name=spec.short_name,
                display_name=spec.display_name,
                parameter_tier=spec.parameter_tier,
                architecture_mode=spec.architecture_mode,
                disk_size_gb=spec.disk_size_gb,
                min_vram_gb=spec.min_vram_gb,
                recommended_vram_gb=spec.recommended_vram_gb,
                license=spec.license,
                supports_preset_speakers=spec.supports_preset_speakers,
                supports_instruct=spec.supports_instruct,
                supports_voice_design=spec.supports_voice_design,
                supports_voice_clone=spec.supports_voice_clone,
                is_downloaded=spec.is_downloaded(),
                local_path=str(spec.local_path()),
                is_active=is_active,
                active_device=active["device"] if is_active else None,
                active_dtype=active["dtype"] if is_active else None,
                compatibility=evaluate_compatibility(spec, hw),
            )
        )
    return out


@router.post("/models/download")
def download_model(req: ModelDownloadRequest) -> dict[str, Any]:
    try:
        return tts_engine.start_download(req.model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/models/download/{model_id:path}")
def download_status(model_id: str) -> dict[str, Any]:
    try:
        return tts_engine.get_download_status(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/models/load")
def load_model(req: ModelLoadRequest) -> dict[str, Any]:
    try:
        _, spec, load_sec, warning = tts_engine.ensure_loaded(
            model_id=req.model_id,
            device=req.device,
            allow_shared_vram_overflow=req.allow_shared_vram_overflow,
        )
        set_setting("active_model_id", spec.model_id)
        return {
            "status": "loaded",
            "load_sec": load_sec,
            "warning": warning,
            "active_engine": tts_engine.active_state(),
        }
    except ModelNotDownloadedError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except HardwareCompatibilityError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/voices", response_model=list[VoiceProfileOut])
def api_list_voices(model_id: Optional[str] = None) -> list[VoiceProfileOut]:
    return list_voices(model_id=model_id)


@router.post("/voices/design")
def api_create_designed_voice(req: VoiceDesignCreateRequest) -> dict[str, Any]:
    try:
        profile, metrics = create_designed_voice_profile(
            name=req.name,
            description=req.description,
            instruct=req.instruct,
            reference_text=req.reference_text,
            device=req.device,
        )
        return {"profile": profile, "metrics": metrics}
    except (ValueError, FileNotFoundError, HardwareCompatibilityError, ModelNotDownloadedError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/voices/clone", response_model=VoiceProfileOut)
async def api_create_cloned_voice(
    name: str = Form(...),
    description: str = Form("Custom authorized voice clone"),
    ref_text: str = Form(...),
    consent_confirmed: bool = Form(...),
    audio_file: UploadFile = File(...),
) -> VoiceProfileOut:
    data = await audio_file.read()
    try:
        return create_cloned_voice_profile(
            name=name,
            description=description,
            ref_text=ref_text,
            audio_bytes=data,
            filename=audio_file.filename or "reference.wav",
            consent_confirmed=consent_confirmed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/voices/{voice_id}/prefer", response_model=VoiceProfileOut)
def api_prefer_voice(voice_id: str) -> VoiceProfileOut:
    try:
        return set_preferred_voice(voice_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/voices/{voice_id}")
def api_delete_voice(voice_id: str) -> dict[str, Any]:
    try:
        return delete_voice(voice_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/voices/{voice_id}/sample")
def api_get_voice_sample(voice_id: str) -> FileResponse:
    try:
        voice = get_voice(voice_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not voice.ref_audio_path or not Path(voice.ref_audio_path).exists():
        raise HTTPException(status_code=404, detail="No reference audio file exists for this voice yet.")
    return FileResponse(voice.ref_audio_path, media_type="audio/wav", filename=f"{voice_id}.wav")


@router.get("/tts/lab/meta")
def api_lab_meta() -> dict[str, Any]:
    return {
        "fixed_sample_script": FIXED_SAMPLE_SCRIPT,
        "calibration_passage": CALIBRATION_PASSAGE,
    }


@router.get("/tts/lab/samples")
def api_list_lab_samples() -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM lab_samples ORDER BY created_at DESC LIMIT 30"
        ).fetchall()
    return [
        {
            "sample_id": r["sample_id"],
            "voice_id": r["voice_id"],
            "voice_name": r["voice_name"],
            "model_id": r["model_id"],
            "device_used": r["device_used"],
            "dtype_used": r["dtype_used"],
            "text": r["text"],
            "instruct": r["instruct"],
            "audio_url": f"/api/tts/lab/audio/{r['sample_id']}",
            "audio_duration_sec": r["audio_duration_sec"],
            "generation_sec": r["generation_sec"],
            "load_sec": r["load_sec"],
            "rtf": r["rtf"],
            "peak_vram_mb": r["peak_vram_mb"],
            "ram_mb": r["ram_mb"],
            "sample_rate": r["sample_rate"],
            "created_at": r["created_at"],
        }
        for r in rows
        if Path(r["audio_path"]).exists()
    ]


@router.get("/tts/lab/audio/{sample_id}")
def api_lab_audio(sample_id: str) -> FileResponse:
    with get_db() as conn:
        row = conn.execute("SELECT audio_path FROM lab_samples WHERE sample_id = ?", (sample_id,)).fetchone()
    if not row or not Path(row["audio_path"]).exists():
        raise HTTPException(status_code=404, detail="Lab sample audio not found.")
    return FileResponse(row["audio_path"], media_type="audio/wav", filename=f"{sample_id}.wav")


@router.delete("/tts/lab/samples/{sample_id}")
def api_delete_lab_sample(sample_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT audio_path FROM lab_samples WHERE sample_id = ?", (sample_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Sample not found.")
        conn.execute("DELETE FROM lab_samples WHERE sample_id = ?", (sample_id,))
    Path(row["audio_path"]).unlink(missing_ok=True)
    return {"deleted": True, "sample_id": sample_id}


@router.post("/tts/lab/generate", response_model=LabGenerateResponse)
def api_lab_generate(req: LabGenerateRequest) -> LabGenerateResponse:
    try:
        spec = get_model_spec(req.model_id)
        voice = get_voice(req.voice_id)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if req.model_id not in voice.compatible_models:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Voice '{voice.name}' ({voice.kind}) is not compatible with checkpoint '{spec.short_name}'. "
                f"Compatible checkpoints: {', '.join(voice.compatible_models)}"
            ),
        )

    try:
        instruct_applied: Optional[str] = None
        if spec.architecture_mode == "custom_voice":
            if not voice.speaker_name:
                raise HTTPException(status_code=400, detail="Selected voice lacks a preset speaker_name.")
            if spec.supports_instruct and req.instruct:
                instruct_applied = req.instruct.strip()
            result = tts_engine.synthesize_custom_voice(
                model_id=spec.model_id,
                text=req.text.strip(),
                speaker=voice.speaker_name,
                language=req.language,
                instruct=instruct_applied,
                device=req.device,
            )
        elif spec.architecture_mode == "voice_design":
            eff_instruct = (req.instruct or voice.instruct_prompt or "").strip()
            if not eff_instruct:
                raise HTTPException(status_code=400, detail="VoiceDesign requires a natural-language voice description.")
            instruct_applied = eff_instruct
            result = tts_engine.synthesize_voice_design(
                model_id=spec.model_id,
                text=req.text.strip(),
                instruct=eff_instruct,
                language=req.language,
                device=req.device,
            )
        elif spec.architecture_mode == "base":
            if voice.kind == "designed_narrator" and voice.ref_audio_path and not Path(voice.ref_audio_path).exists():
                ensure_narrator_reference_clip(voice.voice_id, device="auto")
            if not voice.ref_audio_path or not Path(voice.ref_audio_path).exists():
                raise HTTPException(
                    status_code=400,
                    detail=f"Voice '{voice.name}' is missing its local reference audio file.",
                )
            result = tts_engine.synthesize_voice_clone(
                model_id=spec.model_id,
                text=req.text.strip(),
                ref_audio=voice.ref_audio_path,
                ref_text=voice.ref_text,
                language=req.language,
                prompt_cache_path=Path(voice.prompt_cache_path) if voice.prompt_cache_path else None,
                device=req.device,
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported architecture mode: {spec.architecture_mode}")
    except ModelNotDownloadedError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except HardwareCompatibilityError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {type(exc).__name__}: {exc}") from exc

    sample_id = f"lab-{uuid.uuid4().hex[:10]}"
    out_wav = _lab_dir() / f"{sample_id}.wav"
    sf.write(str(out_wav), result.wavs[0], result.sample_rate)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO lab_samples (
                sample_id, voice_id, voice_name, model_id, device_used, dtype_used,
                text, instruct, audio_path, audio_duration_sec, generation_sec, load_sec,
                rtf, peak_vram_mb, ram_mb, sample_rate, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sample_id,
                voice.voice_id,
                voice.name,
                result.model_id,
                result.device_used,
                result.dtype_used,
                req.text.strip(),
                instruct_applied,
                str(out_wav),
                result.audio_duration_sec,
                result.gen_sec,
                result.load_sec,
                result.rtf,
                result.peak_vram_mb,
                result.ram_mb,
                result.sample_rate,
                now,
            ),
        )

    return LabGenerateResponse(
        sample_id=sample_id,
        voice_id=voice.voice_id,
        voice_name=voice.name,
        model_id=result.model_id,
        device_used=result.device_used,
        dtype_used=result.dtype_used,
        audio_url=f"/api/tts/lab/audio/{sample_id}",
        audio_duration_sec=result.audio_duration_sec,
        generation_sec=result.gen_sec,
        load_sec=result.load_sec,
        rtf=result.rtf,
        peak_vram_mb=result.peak_vram_mb,
        ram_mb=result.ram_mb,
        sample_rate=result.sample_rate,
        instruct_applied=instruct_applied,
        warning=result.warning,
    )


@router.get("/settings")
def api_get_settings() -> dict[str, Any]:
    return get_all_settings()


@router.put("/settings")
def api_update_settings(req: SettingsUpdate) -> dict[str, Any]:
    for key, val in req.values.items():
        set_setting(key, val)
    return get_all_settings()

