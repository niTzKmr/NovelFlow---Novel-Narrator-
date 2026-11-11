"""FastAPI router for Standalone Text-to-Speech Studio (/api/tts-studio)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.database.db import get_setting
from app.models.schemas import DevicePreference
from app.services.audiobook import audiobook_queue
from app.services.tts_studio import (
    get_compatible_studio_voices,
    get_studio_capabilities,
    is_studio_enabled,
    plan_studio_text,
    set_studio_enabled,
    tts_studio_manager,
)


router = APIRouter(prefix="/api/tts-studio", tags=["tts-studio"])


class StudioConfigPatch(BaseModel):
    enabled: bool


class StudioPlanRequest(BaseModel):
    text: str = ""
    chunk_batch_size: int = Field(default=1, ge=1, le=4)
    max_chunk_chars: int = Field(default=320, ge=140, le=420)


class StudioPreviewRequest(BaseModel):
    model_id: Optional[str] = None
    device: DevicePreference = "auto"


class StudioGenerateRequest(BaseModel):
    text: str = Field(min_length=1)
    title: Optional[str] = None
    voice_id: str
    model_id: str
    language: str = "English"
    instruct: Optional[str] = None
    device: DevicePreference = "auto"
    output_format: str = "wav"
    chunk_batch_size: int = Field(default=1, ge=1, le=4)
    max_chunk_chars: int = Field(default=320, ge=140, le=420)
    pause_ms: int = Field(default=220, ge=80, le=1000)


def _require_enabled() -> None:
    if not is_studio_enabled():
        raise HTTPException(
            status_code=403,
            detail="Text-to-Speech Studio is disabled in Settings. Enable it in Settings -> Text-to-Speech Studio.",
        )


def _media_type(ext: str) -> str:
    return {"wav": "audio/wav", "mp3": "audio/mpeg", "aac": "audio/aac"}.get(ext.lower(), "audio/wav")


@router.get("/config")
def api_studio_config() -> dict[str, Any]:
    caps = get_studio_capabilities()
    caps["queue_state"] = audiobook_queue.get_queue_state()
    return caps


@router.patch("/config")
def api_studio_update_config(req: StudioConfigPatch) -> dict[str, Any]:
    set_studio_enabled(req.enabled)
    return get_studio_capabilities()


@router.get("/voices")
def api_studio_voices(model_id: Optional[str] = None) -> dict[str, Any]:
    _require_enabled()
    mid = model_id or get_setting("active_model_id", settings.default_model_id)
    try:
        return {"model_id": mid, "voices": get_compatible_studio_voices(mid)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/voices/{voice_id}/preview")
def api_studio_get_voice_preview(voice_id: str, model_id: Optional[str] = None) -> FileResponse:
    _require_enabled()
    try:
        path = tts_studio_manager.resolve_existing_preview(voice_id, model_id=model_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Cached voice preview not available yet; POST to generate one.")
    return FileResponse(str(path), media_type="audio/wav", filename=f"{voice_id}_preview.wav")


@router.post("/voices/{voice_id}/preview")
def api_studio_generate_voice_preview(voice_id: str, req: StudioPreviewRequest) -> dict[str, Any]:
    _require_enabled()
    mid = req.model_id or get_setting("active_model_id", settings.default_model_id)
    try:
        tts_studio_manager.generate_voice_preview(voice_id=voice_id, model_id=mid, device=req.device)
        return {
            "ok": True,
            "voice_id": voice_id,
            "model_id": mid,
            "preview_url": f"/api/tts-studio/voices/{voice_id}/preview?model_id={mid}",
        }
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (KeyError, ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/plan")
def api_studio_plan(req: StudioPlanRequest) -> dict[str, Any]:
    _require_enabled()
    stats, _ = plan_studio_text(req.text, chunk_batch_size=req.chunk_batch_size, max_chunk_chars=req.max_chunk_chars)
    return {
        "char_count": stats.char_count,
        "word_count": stats.word_count,
        "paragraph_count": stats.paragraph_count,
        "sentence_count": stats.sentence_count,
        "chunk_count": stats.chunk_count,
        "queue_state": audiobook_queue.get_queue_state(),
    }


@router.post("/generate")
def api_studio_generate(req: StudioGenerateRequest) -> dict[str, Any]:
    _require_enabled()
    try:
        return tts_studio_manager.enqueue_generation(
            text=req.text,
            voice_id=req.voice_id,
            model_id=req.model_id,
            title=req.title,
            language=req.language,
            instruct=req.instruct,
            device=req.device,
            output_format=req.output_format,
            chunk_batch_size=req.chunk_batch_size,
            max_chunk_chars=req.max_chunk_chars,
            pause_ms=req.pause_ms,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/jobs/{job_id}")
def api_studio_job_status(job_id: str) -> dict[str, Any]:
    _require_enabled()
    try:
        return tts_studio_manager.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel")
def api_studio_cancel_job(job_id: str) -> dict[str, Any]:
    _require_enabled()
    try:
        return tts_studio_manager.cancel_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/history")
def api_studio_history(limit: int = 40) -> dict[str, Any]:
    _require_enabled()
    return {"items": tts_studio_manager.list_history(limit=limit)}


@router.get("/items/{job_id}/audio")
def api_studio_stream_audio(job_id: str) -> FileResponse:
    _require_enabled()
    try:
        item = tts_studio_manager.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    path_str = item.get("audio_path")
    if not path_str or not Path(path_str).exists():
        raise HTTPException(status_code=404, detail="Generated audio file does not exist.")
    fmt = (item.get("audio_format") or "wav").lower()
    return FileResponse(path_str, media_type=_media_type(fmt))


@router.get("/items/{job_id}/download")
def api_studio_download_audio(job_id: str) -> FileResponse:
    _require_enabled()
    try:
        item = tts_studio_manager.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    path_str = item.get("audio_path")
    if not path_str or not Path(path_str).exists():
        raise HTTPException(status_code=404, detail="Generated audio file does not exist.")
    fmt = (item.get("audio_format") or "wav").lower()
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", (item.get("title") or job_id)).strip("_") or job_id
    fname = f"NovelFlow_{slug}.{fmt}"
    return FileResponse(
        path_str,
        media_type=_media_type(fmt),
        filename=fname,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.delete("/items/{job_id}")
def api_studio_delete_item(job_id: str) -> dict[str, Any]:
    _require_enabled()
    deleted = tts_studio_manager.delete_item(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Studio item '{job_id}' not found.")
    return {"ok": True, "deleted_job_id": job_id}

