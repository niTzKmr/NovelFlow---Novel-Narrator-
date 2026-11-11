"""FastAPI routes for audiobook chapter generation, streaming, audio caching, storage, and privacy."""

from __future__ import annotations

import io
import shutil
from pathlib import Path
from typing import Any, Optional

import soundfile as sf
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.database.db import get_db, get_setting, init_database
from app.models.schemas import DevicePreference
from app.services.audiobook import audiobook_queue
from app.services.voices import ensure_narrator_reference_clip, get_voice, seed_builtin_voices
from app.tts.engine import HardwareCompatibilityError, ModelNotDownloadedError, tts_engine
from app.tts.registry import get_model_spec
from app.tts.segmenter import split_paragraph_sentences


router = APIRouter(prefix="/api", tags=["audiobook"])


class AudiobookGenerateRequest(BaseModel):
    chapter_id: str
    voice_id: str
    model_id: str
    start_sentence_index: int = 0
    device: DevicePreference = "auto"
    pregenerate_next: bool = True


class PrioritySentenceRequest(BaseModel):
    chapter_id: str
    sentence_index: int


class DirectTtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice_id: str
    model_id: str
    instruct: Optional[str] = None
    device: DevicePreference = "auto"
    language: str = "English"


class ClearCacheRequest(BaseModel):
    book_id: Optional[str] = None


class PrivacyDeleteAllRequest(BaseModel):
    confirm_phrase: str


@router.post("/audiobook/generate")
def api_audiobook_generate(req: AudiobookGenerateRequest) -> dict[str, Any]:
    try:
        return audiobook_queue.enqueue_chapter(
            chapter_id=req.chapter_id,
            voice_id=req.voice_id,
            model_id=req.model_id,
            start_sentence_index=req.start_sentence_index,
            device=req.device,
            allow_pregenerate_next=req.pregenerate_next,
        )
    except (KeyError, ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/audiobook/prioritize")
def api_audiobook_prioritize(req: PrioritySentenceRequest) -> dict[str, Any]:
    audiobook_queue.prioritize_sentence(req.chapter_id, req.sentence_index)
    return {"ok": True, "chapter_id": req.chapter_id, "sentence_index": req.sentence_index}


@router.get("/audiobook/chapter/{chapter_id}/status")
def api_chapter_audio_status(
    chapter_id: str,
    voice_id: Optional[str] = None,
    model_id: Optional[str] = None,
) -> dict[str, Any]:
    vid = voice_id or get_setting("preferred_voice_id", "narrator-deep-cinematic")
    mid = model_id or get_setting("active_model_id", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    try:
        return audiobook_queue.get_chapter_audio_status(chapter_id, voice_id=vid, model_id=mid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/audiobook/chunks/{chunk_key}/audio")
def api_get_chunk_audio(chunk_key: str) -> FileResponse:
    with get_db() as conn:
        row = conn.execute("SELECT audio_path, format FROM audio_chunks WHERE chunk_key = ?", (chunk_key,)).fetchone()
    if not row or not Path(row["audio_path"]).exists():
        raise HTTPException(status_code=404, detail="Cached audio chunk not found.")
    fmt = row["format"]
    mtype = "audio/wav" if fmt == "wav" else ("audio/mpeg" if fmt == "mp3" else "audio/aac")
    return FileResponse(row["audio_path"], media_type=mtype, filename=f"{chunk_key}.{fmt}")


@router.get("/tts/jobs/{job_id}")
def api_get_tts_job(job_id: str) -> dict[str, Any]:
    try:
        return audiobook_queue.get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/tts/jobs/{job_id}/cancel")
def api_cancel_tts_job(job_id: str) -> dict[str, Any]:
    try:
        return audiobook_queue.cancel_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/tts/generate")
def api_tts_generate(req: DirectTtsRequest) -> StreamingResponse:
    try:
        spec = get_model_spec(req.model_id)
        voice = get_voice(req.voice_id)
        if spec.architecture_mode == "base":
            if voice.kind == "designed_narrator" and voice.ref_audio_path and not Path(voice.ref_audio_path).exists():
                ensure_narrator_reference_clip(voice.voice_id, device="auto")
            res = tts_engine.synthesize_voice_clone(
                model_id=req.model_id,
                text=req.text,
                ref_audio=voice.ref_audio_path,
                ref_text=voice.ref_text,
                language=req.language,
                prompt_cache_path=Path(voice.prompt_cache_path) if voice.prompt_cache_path else None,
                device=req.device,
            )
        elif spec.architecture_mode == "custom_voice":
            res = tts_engine.synthesize_custom_voice(
                model_id=req.model_id,
                text=req.text,
                speaker=voice.speaker_name,
                language=req.language,
                instruct=req.instruct if spec.supports_instruct else None,
                device=req.device,
            )
        else:
            res = tts_engine.synthesize_voice_design(
                model_id=req.model_id,
                text=req.text,
                instruct=req.instruct or voice.instruct_prompt or "",
                language=req.language,
                device=req.device,
            )
    except (KeyError, ValueError, FileNotFoundError, HardwareCompatibilityError, ModelNotDownloadedError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    buf = io.BytesIO()
    sf.write(buf, res.wavs[0], res.sample_rate, format="WAV")
    buf.seek(0)
    return StreamingResponse(buf, media_type="audio/wav")


@router.post("/tts/stream")
def api_tts_stream(req: DirectTtsRequest) -> StreamingResponse:
    """Stream sentence-segmented WAV buffers progressively as each sentence synthesizes."""
    sentences = split_paragraph_sentences(req.text)
    if not sentences:
        raise HTTPException(status_code=400, detail="Input text contains no speakable sentences.")

    try:
        spec = get_model_spec(req.model_id)
        voice = get_voice(req.voice_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _gen():
        for sent in sentences:
            if spec.architecture_mode == "base":
                res = tts_engine.synthesize_voice_clone(
                    model_id=req.model_id,
                    text=sent,
                    ref_audio=voice.ref_audio_path,
                    ref_text=voice.ref_text,
                    language=req.language,
                    prompt_cache_path=Path(voice.prompt_cache_path) if voice.prompt_cache_path else None,
                    device=req.device,
                )
            elif spec.architecture_mode == "custom_voice":
                res = tts_engine.synthesize_custom_voice(
                    model_id=req.model_id,
                    text=sent,
                    speaker=voice.speaker_name,
                    language=req.language,
                    instruct=req.instruct if spec.supports_instruct else None,
                    device=req.device,
                )
            else:
                res = tts_engine.synthesize_voice_design(
                    model_id=req.model_id,
                    text=sent,
                    instruct=req.instruct or voice.instruct_prompt or "",
                    language=req.language,
                    device=req.device,
                )
            buf = io.BytesIO()
            sf.write(buf, res.wavs[0], res.sample_rate, format="WAV")
            yield buf.getvalue()

    return StreamingResponse(_gen(), media_type="audio/wav")


def _dir_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


@router.get("/storage/stats")
def api_storage_stats() -> dict[str, Any]:
    with get_db() as conn:
        chunk_count = conn.execute("SELECT COUNT(*) FROM audio_chunks").fetchone()[0]
        book_count = conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    audio_bytes = _dir_size_bytes(settings.audio_dir)
    books_bytes = _dir_size_bytes(settings.books_dir)
    voices_bytes = _dir_size_bytes(settings.voices_dir)
    cache_bytes = _dir_size_bytes(settings.cache_dir)
    models_bytes = _dir_size_bytes(settings.models_dir)
    return {
        "books_location": str(settings.books_dir),
        "audio_location": str(settings.audio_dir),
        "voices_location": str(settings.voices_dir),
        "models_location": str(settings.models_dir),
        "book_count": book_count,
        "cached_chunk_count": chunk_count,
        "books_mb": round(books_bytes / (1024 * 1024), 2),
        "audio_cache_mb": round(audio_bytes / (1024 * 1024), 2),
        "voices_mb": round(voices_bytes / (1024 * 1024), 2),
        "temp_cache_mb": round(cache_bytes / (1024 * 1024), 2),
        "models_gb": round(models_bytes / (1024 ** 3), 2),
    }


@router.post("/storage/clear-cache")
def api_clear_audio_cache(req: ClearCacheRequest) -> dict[str, Any]:
    with get_db() as conn:
        if req.book_id:
            rows = conn.execute("SELECT chunk_key, audio_path FROM audio_chunks WHERE book_id = ?", (req.book_id,)).fetchall()
            conn.execute("DELETE FROM audio_chunks WHERE book_id = ?", (req.book_id,))
        else:
            rows = conn.execute("SELECT chunk_key, audio_path FROM audio_chunks").fetchall()
            conn.execute("DELETE FROM audio_chunks")
    removed = 0
    for r in rows:
        p = Path(r["audio_path"])
        if p.exists():
            p.unlink(missing_ok=True)
            removed += 1
    if not req.book_id:
        shutil.rmtree(settings.audio_dir, ignore_errors=True)
        settings.audio_dir.mkdir(parents=True, exist_ok=True)
    return {"cleared": True, "removed_files": removed}


@router.post("/storage/clear-temp")
def api_clear_temp() -> dict[str, Any]:
    shutil.rmtree(settings.cache_dir, ignore_errors=True)
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    return {"cleared": True}


@router.post("/privacy/delete-all")
def api_delete_all_data(req: PrivacyDeleteAllRequest) -> dict[str, Any]:
    if req.confirm_phrase.strip().upper() != "DELETE ALL":
        raise HTTPException(status_code=400, detail="Type 'DELETE ALL' to confirm wiping all local NovelFlow library & voice data.")
    tts_engine.unload()
    for d in (settings.books_dir, settings.audio_dir, settings.cache_dir):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
    # Remove user-imported voices & lab samples, keeping built-in definitions clean
    lab_dir = settings.voices_dir / "lab_samples"
    shutil.rmtree(lab_dir, ignore_errors=True)
    with get_db() as conn:
        conn.execute("DELETE FROM books")
        conn.execute("DELETE FROM audio_chunks")
        conn.execute("DELETE FROM tts_jobs")
        conn.execute("DELETE FROM lab_samples")
        conn.execute("DELETE FROM voice_profiles WHERE is_builtin = 0")
    init_database()
    seed_builtin_voices()
    return {"wiped": True}

