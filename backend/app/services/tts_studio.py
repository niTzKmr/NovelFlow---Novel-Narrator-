"""Standalone offline Text-to-Speech Studio service built cleanly on top of NovelFlow's Qwen3-TTS engine.

Safety & Isolation:
- Disabled cleanly via ``tts_studio_enabled`` app_settings flag.
- Uses its own SQLite table (``tts_studio_jobs``) and local storage directory (``storage/tts_studio/``).
- Never touches EPUB books, ``audio_chunks``, ``tts_jobs``, ``storage/audio/``, CUDA Graphs, or prewarming.
- All synthesis runs sequentially through ``audiobook_queue.submit_exclusive_task`` (single GPU worker).
- Preserves completed chunks as a playable/downloadable partial output if a later chunk fails or is canceled.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf

from app.core.config import settings
from app.database.db import get_db, get_setting, set_setting
from app.services.audiobook import _encode_audio_file, _trim_excess_silence, audiobook_queue
from app.services.hardware import detect_hardware
from app.services.voices import ensure_narrator_reference_clip, get_voice, list_voices
from app.tts.engine import tts_engine
from app.tts.registry import get_model_spec
from app.tts.segmenter import ChunkPlan, SentenceItem, build_chunk_plans, split_paragraph_sentences


STUDIO_FLAG_KEY = "tts_studio_enabled"
PREVIEW_SENTENCE = "Welcome to NovelFlow Text to Speech Studio. Every word is synthesized locally on your computer."

_STUDIO_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tts_studio_jobs (
    job_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    input_text TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    voice_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'English',
    instruct TEXT,
    device TEXT NOT NULL DEFAULT 'auto',
    output_format TEXT NOT NULL DEFAULT 'wav',
    chunk_batch_size INTEGER NOT NULL DEFAULT 1,
    max_chunk_chars INTEGER NOT NULL DEFAULT 320,
    pause_ms INTEGER NOT NULL DEFAULT 220,
    status TEXT NOT NULL,
    total_chunks INTEGER NOT NULL DEFAULT 0,
    completed_chunks INTEGER NOT NULL DEFAULT 0,
    current_chunk_text TEXT,
    audio_path TEXT,
    audio_format TEXT,
    duration_sec REAL NOT NULL DEFAULT 0.0,
    sample_rate INTEGER NOT NULL DEFAULT 24000,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    warning TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


@dataclass
class StudioTextStats:
    char_count: int
    word_count: int
    paragraph_count: int
    sentence_count: int
    chunk_count: int


def get_studio_dir() -> Path:
    d = settings.storage_dir / "tts_studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_studio_schema() -> None:
    with get_db() as conn:
        conn.executescript(_STUDIO_SCHEMA_SQL)


def is_studio_enabled() -> bool:
    val = get_setting(STUDIO_FLAG_KEY, None)
    if val is None:
        return True
    return bool(val)


def set_studio_enabled(enabled: bool) -> bool:
    set_setting(STUDIO_FLAG_KEY, bool(enabled))
    return bool(enabled)


def get_studio_capabilities() -> dict[str, Any]:
    hw = detect_hardware()
    return {
        "enabled": is_studio_enabled(),
        "ffmpeg_available": bool(hw.ffmpeg_available and hw.ffmpeg_path),
        "supported_output_formats": ["wav", "mp3", "aac"] if (hw.ffmpeg_available and hw.ffmpeg_path) else ["wav"],
        "supports_generation_speed": False,
        "supports_elevenlabs_sliders": False,
        "playback_speed_range": [0.75, 2.0],
        "pause_ms_range": [80, 1000],
        "chunk_batch_range": [1, 4],
        "max_chunk_chars_range": [140, 420],
    }


def plan_studio_text(
    text: str,
    chunk_batch_size: int = 1,
    max_chunk_chars: int = 320,
) -> tuple[StudioTextStats, list[ChunkPlan]]:
    """Split arbitrary single- or multi-paragraph text into ordered TTS chunks without truncation."""
    raw = (text or "").replace("\r\n", "\n").strip()
    if not raw:
        return StudioTextStats(0, 0, 0, 0, 0), []

    raw_paragraphs = [p.strip() for p in re.split(r"\n+", raw) if p.strip()]
    sentences: list[SentenceItem] = []
    sent_idx = 0
    for p_idx, para in enumerate(raw_paragraphs):
        for s_text in split_paragraph_sentences(para):
            sentences.append(SentenceItem(sentence_index=sent_idx, paragraph_index=p_idx, text=s_text))
            sent_idx += 1

    clamped_batch = max(1, min(int(chunk_batch_size), 4))
    clamped_chars = max(140, min(int(max_chunk_chars), 420))
    plans = build_chunk_plans(sentences, batch_size=clamped_batch, max_chunk_chars=clamped_chars)

    words = len(re.findall(r"\S+", raw))
    stats = StudioTextStats(
        char_count=len(raw),
        word_count=words,
        paragraph_count=len(raw_paragraphs),
        sentence_count=len(sentences),
        chunk_count=len(plans),
    )
    return stats, plans


def _derive_title(text: str, explicit_title: Optional[str]) -> str:
    clean = (explicit_title or "").strip()
    if clean:
        return clean[:90]
    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "Untitled Speech")
    words = first_line.split()
    snippet = " ".join(words[:7])
    if len(words) > 7:
        snippet += "..."
    return snippet[:90] or "Untitled Speech"


def _ensure_punctuation(text: str) -> str:
    t = text.strip()
    if t and t[-1] not in ".!?…:;。！？”'\")":
        return f"{t}."
    return t


def _chunk_text_for_plan(plan: ChunkPlan) -> str:
    return " ".join(_ensure_punctuation(s.text) for s in plan.sentences)


def _preview_cache_path(voice_id: str, model_id: str) -> Path:
    spec = get_model_spec(model_id)
    h = hashlib.sha256(f"{voice_id}|{spec.model_id}".encode("utf-8")).hexdigest()[:12]
    return get_studio_dir() / "previews" / f"{voice_id}_{spec.short_name}_{h}.wav"


def get_compatible_studio_voices(model_id: str) -> list[dict[str, Any]]:
    voices = list_voices(model_id=model_id)
    out: list[dict[str, Any]] = []
    for v in voices:
        has_ref_file = bool(v.ref_audio_path and Path(v.ref_audio_path).exists())
        cached_preview = _preview_cache_path(v.voice_id, model_id)
        has_preview = has_ref_file or cached_preview.exists()
        d = v.model_dump()
        d["preview_ready"] = has_preview
        d["preview_url"] = f"/api/tts-studio/voices/{v.voice_id}/preview?model_id={model_id}"
        out.append(d)
    return out


class TtsStudioManager:
    """Thread-safe background coordinator for standalone Text-to-Speech Studio synthesis."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._cancelled_jobs: set[str] = set()
        self._preview_lock = threading.Lock()
        self._recovered_dbs: set[str] = set()

    def _ensure_ready(self) -> None:
        ensure_studio_schema()
        db_key = str(Path(settings.db_path).resolve()) if settings.db_path else "default"
        with self._lock:
            if db_key in self._recovered_dbs:
                return
            self._recovered_dbs.add(db_key)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with get_db() as conn:
            conn.execute(
                """
                UPDATE tts_studio_jobs
                SET status = CASE WHEN audio_path IS NOT NULL AND audio_path != '' THEN 'partial' ELSE 'failed' END,
                    error_message = COALESCE(error_message, 'Application restarted before synthesis finished.'),
                    updated_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (now,),
            )

    def _serialize_row(self, row: Any) -> dict[str, Any]:
        d = dict(row)
        audio_exists = bool(d.get("audio_path") and Path(str(d["audio_path"])).exists())
        d["audio_available"] = audio_exists
        d["audio_url"] = f"/api/tts-studio/items/{d['job_id']}/audio" if audio_exists else None
        d["download_url"] = f"/api/tts-studio/items/{d['job_id']}/download" if audio_exists else None
        q_state = audiobook_queue.get_queue_state()
        waiting = d["status"] == "queued" and bool(q_state["busy"])
        d["waiting_for_queue"] = waiting
        d["queue_active_task"] = q_state["active_task"] if waiting else None
        return d

    def resolve_existing_preview(self, voice_id: str, model_id: Optional[str] = None) -> Optional[Path]:
        voice = get_voice(voice_id)
        if voice.ref_audio_path and Path(voice.ref_audio_path).exists():
            return Path(voice.ref_audio_path)
        mid = model_id or get_setting("active_model_id", settings.default_model_id)
        if mid in voice.compatible_models:
            cached = _preview_cache_path(voice_id, mid)
            if cached.exists():
                return cached
        # Fall back to any latest lab sample if present on disk
        with get_db() as conn:
            row = conn.execute(
                "SELECT audio_path FROM lab_samples WHERE voice_id = ? ORDER BY created_at DESC LIMIT 1",
                (voice_id,),
            ).fetchone()
        if row and Path(row["audio_path"]).exists():
            return Path(row["audio_path"])
        return None

    def generate_voice_preview(
        self,
        voice_id: str,
        model_id: str,
        device: str = "auto",
    ) -> Path:
        if not is_studio_enabled():
            raise PermissionError("Text-to-Speech Studio is disabled in Settings.")
        existing = self.resolve_existing_preview(voice_id, model_id)
        if existing is not None:
            return existing

        spec = get_model_spec(model_id)
        voice = get_voice(voice_id)
        if model_id not in voice.compatible_models:
            raise ValueError(f"Voice '{voice.name}' is not compatible with checkpoint '{spec.short_name}'.")

        target_path = _preview_cache_path(voice_id, model_id)
        target_path.parent.mkdir(parents=True, exist_ok=True)

        with self._preview_lock:
            if target_path.exists():
                return target_path

            done = threading.Event()
            err_holder: list[BaseException] = []

            def _task() -> None:
                try:
                    res = self._synthesize_single_text(
                        text=PREVIEW_SENTENCE,
                        voice_id=voice_id,
                        model_id=model_id,
                        language="English",
                        instruct=voice.instruct_prompt if spec.supports_instruct else None,
                        device=device,
                    )
                    wav = _trim_excess_silence(res.wavs[0].astype(np.float32), res.sample_rate)
                    sf.write(str(target_path), wav, res.sample_rate)
                except BaseException as exc:
                    err_holder.append(exc)
                finally:
                    done.set()

            audiobook_queue.submit_exclusive_task(_task, label=f"tts_studio_preview:{voice_id}")
            if not done.wait(timeout=180.0):
                raise TimeoutError("Voice preview timed out waiting for the local GPU queue.")
            if err_holder:
                raise err_holder[0]
            return target_path

    def _synthesize_single_text(
        self,
        text: str,
        voice_id: str,
        model_id: str,
        language: str,
        instruct: Optional[str],
        device: str,
    ):
        spec = get_model_spec(model_id)
        voice = get_voice(voice_id)
        if model_id not in voice.compatible_models:
            raise ValueError(f"Voice '{voice.name}' is not compatible with '{spec.short_name}'.")

        if spec.architecture_mode == "base":
            if voice.kind == "designed_narrator" and voice.ref_audio_path and not Path(voice.ref_audio_path).exists():
                ensure_narrator_reference_clip(voice.voice_id, device="auto")
            return tts_engine.synthesize_voice_clone(
                model_id=model_id,
                text=[text],
                ref_audio=voice.ref_audio_path,
                ref_text=voice.ref_text,
                language=language,
                prompt_cache_path=Path(voice.prompt_cache_path) if voice.prompt_cache_path else None,
                device=device,
            )
        if spec.architecture_mode == "custom_voice":
            eff_instruct = [instruct] if (spec.supports_instruct and instruct and instruct.strip()) else None
            return tts_engine.synthesize_custom_voice(
                model_id=model_id,
                text=[text],
                speaker=[voice.speaker_name],
                language=[language],
                instruct=eff_instruct,
                device=device,
            )
        if spec.architecture_mode == "voice_design":
            eff_instruct = (instruct or voice.instruct_prompt or "").strip()
            return tts_engine.synthesize_voice_design(
                model_id=model_id,
                text=[text],
                instruct=[eff_instruct],
                language=[language],
                device=device,
            )
        raise ValueError(f"Unsupported architecture mode: {spec.architecture_mode}")

    def enqueue_generation(
        self,
        text: str,
        voice_id: str,
        model_id: str,
        title: Optional[str] = None,
        language: str = "English",
        instruct: Optional[str] = None,
        device: str = "auto",
        output_format: str = "wav",
        chunk_batch_size: int = 1,
        max_chunk_chars: int = 320,
        pause_ms: int = 220,
    ) -> dict[str, Any]:
        self._ensure_ready()
        if not is_studio_enabled():
            raise PermissionError("Text-to-Speech Studio is disabled in Settings.")

        stats, plans = plan_studio_text(text, chunk_batch_size=chunk_batch_size, max_chunk_chars=max_chunk_chars)
        if not plans:
            raise ValueError("Input text does not contain any speakable sentences.")

        spec = get_model_spec(model_id)
        voice = get_voice(voice_id)
        if model_id not in voice.compatible_models:
            raise ValueError(
                f"Selected voice '{voice.name}' is incompatible with model '{spec.short_name}'."
            )

        fmt = (output_format or "wav").lower().strip()
        if fmt not in ("wav", "mp3", "aac"):
            raise ValueError(f"Unsupported output format '{fmt}'. Choose wav, mp3, or aac.")

        hw = detect_hardware()
        warning: Optional[str] = None
        if fmt in ("mp3", "aac") and not (hw.ffmpeg_available and hw.ffmpeg_path):
            warning = f"FFmpeg was not found locally; output will be encoded as lossless WAV instead of {fmt.upper()}."
            fmt = "wav"

        eff_instruct = instruct.strip() if (instruct and spec.supports_instruct) else None
        if instruct and instruct.strip() and not spec.supports_instruct:
            note = f"{spec.short_name} does not support style instructions; instruction text was ignored."
            warning = f"{warning} {note}".strip() if warning else note

        clamped_pause = max(80, min(int(pause_ms), 1000))
        clamped_batch = max(1, min(int(chunk_batch_size), 4))
        clamped_chars = max(140, min(int(max_chunk_chars), 420))

        job_id = f"tts-{uuid.uuid4().hex[:12]}"
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        clean_title = _derive_title(text, title)

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO tts_studio_jobs (
                    job_id, title, input_text, voice_id, voice_name, model_id,
                    language, instruct, device, output_format, chunk_batch_size,
                    max_chunk_chars, pause_ms, status, total_chunks, completed_chunks,
                    current_chunk_text, warning, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, ?, ?, ?)
                """,
                (
                    job_id,
                    clean_title,
                    text.strip(),
                    voice.voice_id,
                    voice.name,
                    model_id,
                    language or "English",
                    eff_instruct,
                    device or "auto",
                    fmt,
                    clamped_batch,
                    clamped_chars,
                    clamped_pause,
                    len(plans),
                    warning,
                    now,
                    now,
                ),
            )

        audiobook_queue.submit_exclusive_task(
            lambda jid=job_id: self._process_job(jid),
            label=f"tts_studio:{job_id}",
        )
        return self.get_job(job_id)

    def _assemble_chunks(
        self,
        job_id: str,
        chunk_wavs: list[tuple[np.ndarray, int, bool]],
        pause_ms: int,
        target_fmt: str,
    ) -> tuple[Path, float, int]:
        """Concatenate finished chunks cleanly with paragraph-aware pauses and encode output file."""
        sr = chunk_wavs[0][1]
        pause_samples = int(sr * (pause_ms / 1000.0))
        para_extra = int(sr * 0.16)

        pieces: list[np.ndarray] = []
        for idx, (wav, chunk_sr, new_para_next) in enumerate(chunk_wavs):
            if chunk_sr != sr:
                raise RuntimeError(f"Sample rate mismatch across chunks ({chunk_sr} vs {sr}).")
            pieces.append(wav.astype(np.float32))
            if idx < len(chunk_wavs) - 1:
                gap = pause_samples + (para_extra if new_para_next else 0)
                pieces.append(np.zeros(gap, dtype=np.float32))

        merged = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
        ext = target_fmt if target_fmt in ("wav", "mp3", "aac") else "wav"
        out_path = get_studio_dir() / "outputs" / f"{job_id}.{ext}"
        saved_path, _, total_dur = _encode_audio_file([merged], sr, out_path, ext)
        return saved_path, total_dur, sr

    def _process_job(self, job_id: str) -> None:
        ensure_studio_schema()
        with self._lock:
            if job_id in self._cancelled_jobs:
                self._mark_cancelled(job_id, None)
                return

        with get_db() as conn:
            row = conn.execute("SELECT * FROM tts_studio_jobs WHERE job_id = ?", (job_id,)).fetchone()
            if not row or row["status"] == "cancelled":
                return
            conn.execute(
                "UPDATE tts_studio_jobs SET status = 'running', updated_at = ? WHERE job_id = ?",
                (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job_id),
            )

        job = dict(row)
        _, plans = plan_studio_text(
            job["input_text"],
            chunk_batch_size=job["chunk_batch_size"],
            max_chunk_chars=job["max_chunk_chars"],
        )
        chunks_dir = get_studio_dir() / "jobs" / job_id
        chunks_dir.mkdir(parents=True, exist_ok=True)
        completed_wavs: list[tuple[np.ndarray, int, bool]] = []

        try:
            for idx, plan in enumerate(plans):
                with self._lock:
                    if job_id in self._cancelled_jobs:
                        self._finalize_partial_or_cancel(job_id, job, completed_wavs, cancelled=True, err_msg=None)
                        return

                chunk_text = _chunk_text_for_plan(plan)
                with get_db() as conn:
                    conn.execute(
                        "UPDATE tts_studio_jobs SET current_chunk_text = ?, updated_at = ? WHERE job_id = ?",
                        (chunk_text[:180], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job_id),
                    )

                res = self._synthesize_single_text(
                    text=chunk_text,
                    voice_id=job["voice_id"],
                    model_id=job["model_id"],
                    language=job["language"],
                    instruct=job["instruct"],
                    device=job["device"],
                )
                wav = _trim_excess_silence(res.wavs[0].astype(np.float32), res.sample_rate)
                chunk_file = chunks_dir / f"chunk_{idx:04d}.wav"
                sf.write(str(chunk_file), wav, res.sample_rate)

                new_para_next = False
                if idx + 1 < len(plans):
                    last_para = plan.sentences[-1].paragraph_index
                    next_para = plans[idx + 1].sentences[0].paragraph_index
                    new_para_next = next_para > last_para
                completed_wavs.append((wav, res.sample_rate, new_para_next))

                with get_db() as conn:
                    conn.execute(
                        "UPDATE tts_studio_jobs SET completed_chunks = ?, updated_at = ? WHERE job_id = ?",
                        (idx + 1, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job_id),
                    )

            with self._lock:
                if job_id in self._cancelled_jobs:
                    self._finalize_partial_or_cancel(job_id, job, completed_wavs, cancelled=True, err_msg=None)
                    return

            saved_path, total_dur, sr = self._assemble_chunks(
                job_id, completed_wavs, pause_ms=job["pause_ms"], target_fmt=job["output_format"]
            )
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            size_bytes = saved_path.stat().st_size if saved_path.exists() else 0
            with get_db() as conn:
                conn.execute(
                    """
                    UPDATE tts_studio_jobs
                    SET status = 'completed', current_chunk_text = NULL, audio_path = ?, audio_format = ?,
                        duration_sec = ?, sample_rate = ?, size_bytes = ?, updated_at = ?
                    WHERE job_id = ?
                    """,
                    (
                        str(saved_path),
                        saved_path.suffix.lstrip(".").lower(),
                        total_dur,
                        sr,
                        size_bytes,
                        now,
                        job_id,
                    ),
                )
        except Exception as exc:
            self._finalize_partial_or_cancel(
                job_id, job, completed_wavs, cancelled=False, err_msg=f"{type(exc).__name__}: {exc}"
            )

    def _mark_cancelled(self, job_id: str, err_msg: Optional[str]) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with get_db() as conn:
            conn.execute(
                "UPDATE tts_studio_jobs SET status = 'cancelled', current_chunk_text = NULL, error_message = ?, updated_at = ? WHERE job_id = ?",
                (err_msg, now, job_id),
            )

    def _finalize_partial_or_cancel(
        self,
        job_id: str,
        job: dict[str, Any],
        completed_wavs: list[tuple[np.ndarray, int, bool]],
        cancelled: bool,
        err_msg: Optional[str],
    ) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if completed_wavs:
            try:
                saved_path, total_dur, sr = self._assemble_chunks(
                    job_id, completed_wavs, pause_ms=job["pause_ms"], target_fmt=job["output_format"]
                )
                size_bytes = saved_path.stat().st_size if saved_path.exists() else 0
                status = "cancelled" if cancelled else "partial"
                note = (
                    err_msg
                    if err_msg
                    else f"Generation canceled after {len(completed_wavs)} completed chunk(s); partial audio preserved."
                )
                with get_db() as conn:
                    conn.execute(
                        """
                        UPDATE tts_studio_jobs
                        SET status = ?, current_chunk_text = NULL, audio_path = ?, audio_format = ?,
                            duration_sec = ?, sample_rate = ?, size_bytes = ?, error_message = ?, updated_at = ?
                        WHERE job_id = ?
                        """,
                        (
                            status,
                            str(saved_path),
                            saved_path.suffix.lstrip(".").lower(),
                            total_dur,
                            sr,
                            size_bytes,
                            note,
                            now,
                            job_id,
                        ),
                    )
                return
            except Exception as asm_exc:
                err_msg = f"{err_msg or ''} (Failed assembling partial audio: {asm_exc})".strip()

        status = "cancelled" if cancelled else "failed"
        with get_db() as conn:
            conn.execute(
                """
                UPDATE tts_studio_jobs
                SET status = ?, current_chunk_text = NULL, error_message = ?, updated_at = ?
                WHERE job_id = ?
                """,
                (status, err_msg, now, job_id),
            )

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        self._ensure_ready()
        with self._lock:
            self._cancelled_jobs.add(job_id)
        with get_db() as conn:
            row = conn.execute("SELECT status FROM tts_studio_jobs WHERE job_id = ?", (job_id,)).fetchone()
            if not row:
                raise KeyError(f"Studio job '{job_id}' not found.")
            if row["status"] == "queued":
                conn.execute(
                    "UPDATE tts_studio_jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ?",
                    (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job_id),
                )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any]:
        self._ensure_ready()
        with get_db() as conn:
            row = conn.execute("SELECT * FROM tts_studio_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            raise KeyError(f"Studio job '{job_id}' not found.")
        return self._serialize_row(row)

    def list_history(self, limit: int = 40) -> list[dict[str, Any]]:
        self._ensure_ready()
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM tts_studio_jobs ORDER BY created_at DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return [self._serialize_row(r) for r in rows]

    def delete_item(self, job_id: str) -> bool:
        self._ensure_ready()
        with self._lock:
            self._cancelled_jobs.add(job_id)
        with get_db() as conn:
            row = conn.execute("SELECT audio_path FROM tts_studio_jobs WHERE job_id = ?", (job_id,)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM tts_studio_jobs WHERE job_id = ?", (job_id,))
        if row["audio_path"]:
            Path(row["audio_path"]).unlink(missing_ok=True)
        shutil.rmtree(get_studio_dir() / "jobs" / job_id, ignore_errors=True)
        return True


tts_studio_manager = TtsStudioManager()
