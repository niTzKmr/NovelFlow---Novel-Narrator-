"""Audiobook chunk planning, local caching, background task queue, and restart recovery."""

from __future__ import annotations

import hashlib
import json
import queue
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf

from app.core.config import settings
from app.database.db import get_db, get_setting
from app.services.hardware import detect_hardware
from app.services.library import get_book_detail, get_chapter_content
from app.services.voices import ensure_narrator_reference_clip, get_voice
from app.tts.engine import tts_engine
from app.tts.registry import get_model_spec
from app.tts.segmenter import ChunkPlan, SentenceItem, build_chunk_plans


def make_chunk_key(
    book_id: str,
    chapter_id: str,
    chunk_index: int,
    text_hash: str,
    voice_id: str,
    model_id: str,
    audio_format: str,
) -> str:
    raw = f"{book_id}|{chapter_id}|{chunk_index}|{text_hash}|{voice_id}|{model_id}|{audio_format}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _trim_excess_silence(wav: np.ndarray, sr: int, threshold: float = 0.008, pad_ms: int = 90) -> np.ndarray:
    """Trim anomalous long leading/trailing silence while preserving gentle natural breath padding."""
    if len(wav) == 0:
        return wav
    abs_w = np.abs(wav)
    active = np.where(abs_w > threshold)[0]
    if len(active) == 0:
        return wav
    pad = int(sr * (pad_ms / 1000.0))
    start = max(0, int(active[0]) - pad)
    end = min(len(wav), int(active[-1]) + pad)
    return wav[start:end]


def _split_timings_by_acoustic_pauses(
    wav: np.ndarray, sr: int, sentences: list[SentenceItem]
) -> list[dict[str, Any]]:
    """Compute sentence timestamps in a merged waveform by snapping boundaries to real acoustic silence valleys."""
    total_dur = round(float(len(wav)) / float(sr), 4)
    if len(sentences) <= 1 or total_dur <= 0.1:
        return [
            {
                "sentence_index": s.sentence_index,
                "paragraph_index": s.paragraph_index,
                "start_sec": 0.0,
                "end_sec": total_dur,
            }
            for s in sentences
        ]

    # Compute 20ms frame RMS envelope
    hop = max(1, int(sr * 0.02))
    trimmed_len = (len(wav) // hop) * hop
    if trimmed_len < hop * 4:
        step = total_dur / len(sentences)
        return [
            {
                "sentence_index": s.sentence_index,
                "paragraph_index": s.paragraph_index,
                "start_sec": round(i * step, 4),
                "end_sec": round((i + 1) * step, 4),
            }
            for i, s in enumerate(sentences)
        ]

    frames = wav[:trimmed_len].reshape(-1, hop)
    rms = np.sqrt(np.mean(np.square(frames.astype(np.float64)), axis=1))
    total_chars = max(1, sum(len(s.text) for s in sentences))

    boundaries: list[float] = [0.0]
    cum_chars = 0
    for s in sentences[:-1]:
        cum_chars += len(s.text)
        expected_ratio = cum_chars / total_chars
        lo_sec = max(boundaries[-1] + 0.15, (expected_ratio - 0.22) * total_dur)
        hi_sec = min(total_dur - 0.15, (expected_ratio + 0.22) * total_dur)
        lo_idx = max(0, min(len(rms) - 1, int(lo_sec / 0.02)))
        hi_idx = max(lo_idx + 1, min(len(rms), int(hi_sec / 0.02)))
        valley_idx = lo_idx + int(np.argmin(rms[lo_idx:hi_idx]))
        split_sec = round(min(total_dur - 0.05, max(boundaries[-1] + 0.05, valley_idx * 0.02)), 4)
        boundaries.append(split_sec)
    boundaries.append(total_dur)

    return [
        {
            "sentence_index": s.sentence_index,
            "paragraph_index": s.paragraph_index,
            "start_sec": boundaries[i],
            "end_sec": boundaries[i + 1],
        }
        for i, s in enumerate(sentences)
    ]


def _encode_audio_file(wavs: list[np.ndarray], sr: int, target_path: Path, audio_format: str) -> tuple[Path, list[dict[str, Any]], float]:
    """Concatenate sentence waveforms cleanly and record EXACT per-sentence ground-truth timestamps."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    silence_pad = np.zeros(int(sr * 0.14), dtype=np.float32)  # natural 140ms breath pause between sentences
    pieces: list[np.ndarray] = []
    timings: list[dict[str, Any]] = []
    cursor_sec = 0.0

    for i, w in enumerate(wavs):
        w_f32 = _trim_excess_silence(w.astype(np.float32), sr)
        dur = float(len(w_f32)) / float(sr)
        timings.append({"offset": i, "start_sec": round(cursor_sec, 4), "end_sec": round(cursor_sec + dur, 4)})
        pieces.append(w_f32)
        cursor_sec += dur
        if i < len(wavs) - 1:
            pieces.append(silence_pad)
            cursor_sec += float(len(silence_pad)) / float(sr)

    merged = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
    total_dur = round(float(len(merged)) / float(sr), 4)

    if audio_format == "wav":
        sf.write(str(target_path), merged, sr)
        return target_path, timings, total_dur

    # Transcode optional compressed cache (mp3 / aac) via bundled ffmpeg, never losing exact WAV timings
    hw = detect_hardware()
    if not hw.ffmpeg_available or not hw.ffmpeg_path:
        fallback = target_path.with_suffix(".wav")
        sf.write(str(fallback), merged, sr)
        return fallback, timings, total_dur

    tmp_wav = target_path.with_suffix(".tmp.wav")
    sf.write(str(tmp_wav), merged, sr)
    try:
        codec_args = ["-c:a", "libmp3lame", "-b:a", "128k"] if audio_format == "mp3" else ["-c:a", "aac", "-b:a", "128k"]
        subprocess.run(
            [hw.ffmpeg_path, "-y", "-i", str(tmp_wav), *codec_args, str(target_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return target_path, timings, total_dur
    except Exception:
        fallback = target_path.with_suffix(".wav")
        shutil.move(str(tmp_wav), str(fallback))
        return fallback, timings, total_dur
    finally:
        tmp_wav.unlink(missing_ok=True)


class AudiobookQueueManager:
    """Single-worker GPU/CPU safe background synthesis queue with chunk priority & restart recovery."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._job_queue: queue.Queue[str] = queue.Queue()
        self._cancelled_jobs: set[str] = set()
        self._priority_sentence: dict[str, int] = {}
        self._worker_started = False

    def start_worker(self) -> None:
        with self._lock:
            if self._worker_started:
                return
            self._recover_interrupted_jobs()
            t = threading.Thread(target=self._run_loop, name="novelflow-tts-worker", daemon=True)
            t.start()
            self._worker_started = True

    def _recover_interrupted_jobs(self) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with get_db() as conn:
            conn.execute(
                """
                UPDATE tts_jobs
                SET status = 'interrupted',
                    error_message = 'Application restarted while generation was active; click Play or Resume to continue from cached chunks.',
                    updated_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (now,),
            )

    def _plan_chapter(
        self,
        chapter_id: str,
        batch_size: int,
    ) -> tuple[dict[str, Any], list[ChunkPlan]]:
        ch = get_chapter_content(chapter_id)
        sentences = [
            SentenceItem(
                sentence_index=s["sentence_index"],
                paragraph_index=s["paragraph_index"],
                text=s["text"],
            )
            for s in ch["sentences"]
        ]
        plans = build_chunk_plans(sentences, batch_size=batch_size)
        return ch, plans

    def get_chapter_audio_status(
        self,
        chapter_id: str,
        voice_id: str,
        model_id: str,
        audio_format: Optional[str] = None,
        batch_size: Optional[int] = None,
    ) -> dict[str, Any]:
        fmt = (audio_format or get_setting("audio_cache_format", "wav")).lower()
        if fmt not in ("wav", "mp3", "aac"):
            fmt = "wav"
        bs = int(batch_size or get_setting("batch_size", 1))
        ch, plans = self._plan_chapter(chapter_id, batch_size=bs)
        book_id = ch["book_id"]

        keys = [
            make_chunk_key(book_id, chapter_id, p.chunk_index, p.text_hash, voice_id, model_id, fmt)
            for p in plans
        ]
        cached_map: dict[str, Any] = {}
        if keys:
            placeholders = ",".join("?" for _ in keys)
            with get_db() as conn:
                rows = conn.execute(
                    f"SELECT * FROM audio_chunks WHERE chunk_key IN ({placeholders})",
                    keys,
                ).fetchall()
            for r in rows:
                if Path(r["audio_path"]).exists():
                    cached_map[r["chunk_key"]] = r

        chunk_items: list[dict[str, Any]] = []
        cached_count = 0
        total_duration = 0.0
        for plan, ckey in zip(plans, keys):
            row = cached_map.get(ckey)
            if row:
                cached_count += 1
                total_duration += float(row["duration_sec"])
                chunk_items.append(
                    {
                        "chunk_index": plan.chunk_index,
                        "chunk_key": ckey,
                        "sentence_start": plan.sentence_start,
                        "sentence_end": plan.sentence_end,
                        "status": "cached",
                        "audio_url": f"/api/audiobook/chunks/{ckey}/audio",
                        "duration_sec": row["duration_sec"],
                        "sentence_timings": json.loads(row["sentence_timings_json"]),
                    }
                )
            else:
                chunk_items.append(
                    {
                        "chunk_index": plan.chunk_index,
                        "chunk_key": ckey,
                        "sentence_start": plan.sentence_start,
                        "sentence_end": plan.sentence_end,
                        "status": "pending",
                        "audio_url": None,
                        "duration_sec": None,
                        "sentence_timings": [],
                    }
                )

        return {
            "book_id": book_id,
            "chapter_id": chapter_id,
            "voice_id": voice_id,
            "model_id": model_id,
            "format": fmt,
            "total_chunks": len(chunk_items),
            "cached_chunks": cached_count,
            "complete": len(chunk_items) > 0 and cached_count == len(chunk_items),
            "total_cached_duration_sec": round(total_duration, 2),
            "chunks": chunk_items,
        }

    def enqueue_chapter(
        self,
        chapter_id: str,
        voice_id: str,
        model_id: str,
        start_sentence_index: int = 0,
        device: str = "auto",
        allow_pregenerate_next: bool = True,
    ) -> dict[str, Any]:
        self.start_worker()
        spec = get_model_spec(model_id)
        voice = get_voice(voice_id)
        if model_id not in voice.compatible_models:
            raise ValueError(
                f"Voice '{voice.name}' is not compatible with checkpoint '{spec.short_name}'."
            )

        status = self.get_chapter_audio_status(chapter_id, voice_id, model_id)
        if status["complete"]:
            if allow_pregenerate_next:
                self._maybe_enqueue_next_chapter(status["book_id"], chapter_id, voice_id, model_id, device)
            return {
                "job_id": None,
                "status": "completed",
                "already_cached": True,
                "chapter_status": status,
            }

        job_id = f"job-{uuid.uuid4().hex[:12]}"
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO tts_jobs (
                    job_id, book_id, chapter_id, voice_id, model_id, status,
                    total_chunks, completed_chunks, error_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?, ?)
                """,
                (
                    job_id,
                    status["book_id"],
                    chapter_id,
                    voice_id,
                    model_id,
                    status["total_chunks"],
                    status["cached_chunks"],
                    now,
                    now,
                ),
            )
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
                (f"job_meta:{job_id}", json.dumps({
                    "device": device,
                    "start_sentence_index": start_sentence_index,
                    "pregenerate_next": allow_pregenerate_next,
                }), now),
            )

        with self._lock:
            self._priority_sentence[chapter_id] = int(start_sentence_index)
        self._job_queue.put(job_id)

        return {
            "job_id": job_id,
            "status": "queued",
            "already_cached": False,
            "chapter_status": status,
        }

    def prioritize_sentence(self, chapter_id: str, sentence_index: int) -> None:
        with self._lock:
            self._priority_sentence[chapter_id] = int(sentence_index)

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            self._cancelled_jobs.add(job_id)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with get_db() as conn:
            conn.execute(
                "UPDATE tts_jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running')",
                (now, job_id),
            )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any]:
        with get_db() as conn:
            row = conn.execute("SELECT * FROM tts_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            raise KeyError(f"TTS job '{job_id}' not found.")
        return dict(row)

    def _maybe_enqueue_next_chapter(
        self, book_id: str, current_chapter_id: str, voice_id: str, model_id: str, device: str
    ) -> None:
        if not bool(get_setting("pregenerate_next_chapter", True)):
            return
        try:
            book = get_book_detail(book_id)
        except KeyError:
            return
        chapters = book["chapters"]
        cur_idx = next((c["chapter_index"] for c in chapters if c["chapter_id"] == current_chapter_id), None)
        if cur_idx is None or cur_idx + 1 >= len(chapters):
            return
        next_ch = chapters[cur_idx + 1]
        next_status = self.get_chapter_audio_status(next_ch["chapter_id"], voice_id, model_id)
        if not next_status["complete"]:
            with get_db() as conn:
                existing = conn.execute(
                    "SELECT job_id FROM tts_jobs WHERE chapter_id = ? AND voice_id = ? AND model_id = ? AND status IN ('queued', 'running')",
                    (next_ch["chapter_id"], voice_id, model_id),
                ).fetchone()
            if not existing:
                self.enqueue_chapter(
                    chapter_id=next_ch["chapter_id"],
                    voice_id=voice_id,
                    model_id=model_id,
                    start_sentence_index=0,
                    device=device,
                    allow_pregenerate_next=False,
                )

    def _run_loop(self) -> None:
        while True:
            job_id = self._job_queue.get()
            try:
                self._process_job(job_id)
            except Exception:
                pass
            finally:
                self._job_queue.task_done()

    def _process_job(self, job_id: str) -> None:
        with self._lock:
            if job_id in self._cancelled_jobs:
                return

        with get_db() as conn:
            job = conn.execute("SELECT * FROM tts_jobs WHERE job_id = ?", (job_id,)).fetchone()
            meta_row = conn.execute("SELECT value_json FROM app_settings WHERE key = ?", (f"job_meta:{job_id}",)).fetchone()
            if not job or job["status"] == "cancelled":
                return
            meta = json.loads(meta_row["value_json"]) if meta_row else {}
            conn.execute(
                "UPDATE tts_jobs SET status = 'running', updated_at = ? WHERE job_id = ?",
                (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), job_id),
            )

        chapter_id = job["chapter_id"]
        book_id = job["book_id"]
        voice_id = job["voice_id"]
        model_id = job["model_id"]
        device = meta.get("device", "auto")
        pregenerate_next = bool(meta.get("pregenerate_next", False))

        try:
            voice = get_voice(voice_id)
            spec = get_model_spec(model_id)
            fmt = (get_setting("audio_cache_format", "wav") or "wav").lower()
            if fmt not in ("wav", "mp3", "aac"):
                fmt = "wav"
            bs = int(get_setting("batch_size", 1))
            _, plans = self._plan_chapter(chapter_id, batch_size=bs)

            if spec.architecture_mode == "base" and voice.kind == "designed_narrator":
                if voice.ref_audio_path and not Path(voice.ref_audio_path).exists():
                    ensure_narrator_reference_clip(voice.voice_id, device="auto")

            while True:
                with self._lock:
                    if job_id in self._cancelled_jobs:
                        return
                    prio_sent = self._priority_sentence.get(chapter_id, 0)

                status = self.get_chapter_audio_status(chapter_id, voice_id, model_id, audio_format=fmt, batch_size=bs)
                pending = [c for c in status["chunks"] if c["status"] != "cached"]
                if not pending:
                    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    with get_db() as conn:
                        conn.execute(
                            "UPDATE tts_jobs SET status = 'completed', completed_chunks = ?, updated_at = ? WHERE job_id = ?",
                            (status["total_chunks"], now, job_id),
                        )
                    self._enforce_cache_limit()
                    if pregenerate_next:
                        self._maybe_enqueue_next_chapter(book_id, chapter_id, voice_id, model_id, device)
                    return

                # Pick chunk containing or immediately following priority sentence first, wrapping around
                pending_sorted = sorted(
                    pending,
                    key=lambda c: (0 if c["sentence_end"] >= prio_sent else 1, c["chunk_index"]),
                )
                target_chunk = pending_sorted[0]
                plan = plans[target_chunk["chunk_index"]]
                # If multiple short sentences were merged, synthesize as one cohesive utterance
                if len(plan.sentences) > 1 and int(get_setting("batch_size", 1)) == 1:
                    merged_text = " ".join(
                        s.text if s.text and s.text[-1] in ".!?…:;。！？”'\")" else f"{s.text}."
                        for s in plan.sentences
                    )
                    texts = [merged_text]
                    merged_single_utterance = True
                else:
                    texts = [
                        s.text if s.text and s.text[-1] in ".!?…:;。！？”'\")" else f"{s.text}."
                        for s in plan.sentences
                    ]
                    merged_single_utterance = False

                if spec.architecture_mode == "base":
                    res = tts_engine.synthesize_voice_clone(
                        model_id=model_id,
                        text=texts,
                        ref_audio=voice.ref_audio_path,
                        ref_text=voice.ref_text,
                        language="English",
                        prompt_cache_path=Path(voice.prompt_cache_path) if voice.prompt_cache_path else None,
                        device=device,
                    )
                elif spec.architecture_mode == "custom_voice":
                    res = tts_engine.synthesize_custom_voice(
                        model_id=model_id,
                        text=texts,
                        speaker=[voice.speaker_name] * len(texts),
                        language=["English"] * len(texts),
                        device=device,
                    )
                elif spec.architecture_mode == "voice_design":
                    res = tts_engine.synthesize_voice_design(
                        model_id=model_id,
                        text=texts,
                        instruct=[voice.instruct_prompt or ""] * len(texts),
                        language=["English"] * len(texts),
                        device=device,
                    )
                else:
                    raise ValueError(f"Unsupported architecture mode: {spec.architecture_mode}")

                ext = fmt if fmt in ("wav", "mp3", "aac") else "wav"
                out_file = settings.audio_dir / book_id / chapter_id / f"{target_chunk['chunk_key']}.{ext}"
                saved_path, raw_timings, total_dur = _encode_audio_file(res.wavs, res.sample_rate, out_file, ext)

                if merged_single_utterance:
                    trimmed = _trim_excess_silence(res.wavs[0].astype(np.float32), res.sample_rate)
                    sentence_timings = _split_timings_by_acoustic_pauses(trimmed, res.sample_rate, plan.sentences)
                else:
                    sentence_timings = []
                    for sent_item, t_info in zip(plan.sentences, raw_timings):
                        sentence_timings.append(
                            {
                                "sentence_index": sent_item.sentence_index,
                                "paragraph_index": sent_item.paragraph_index,
                                "start_sec": t_info["start_sec"],
                                "end_sec": t_info["end_sec"],
                            }
                        )

                now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                size_bytes = saved_path.stat().st_size if saved_path.exists() else 0
                with get_db() as conn:
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO audio_chunks (
                            chunk_key, book_id, chapter_id, chunk_index, sentence_start, sentence_end,
                            text_hash, voice_id, model_id, audio_path, format, duration_sec,
                            sample_rate, sentence_timings_json, size_bytes, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            target_chunk["chunk_key"],
                            book_id,
                            chapter_id,
                            plan.chunk_index,
                            plan.sentence_start,
                            plan.sentence_end,
                            plan.text_hash,
                            voice_id,
                            model_id,
                            str(saved_path),
                            saved_path.suffix.lstrip("."),
                            total_dur,
                            res.sample_rate,
                            json.dumps(sentence_timings),
                            size_bytes,
                            now,
                        ),
                    )
                    conn.execute(
                        "UPDATE tts_jobs SET completed_chunks = ?, updated_at = ? WHERE job_id = ?",
                        (status["cached_chunks"] + 1, now, job_id),
                    )

        except Exception as exc:
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with get_db() as conn:
                conn.execute(
                    "UPDATE tts_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE job_id = ?",
                    (f"{type(exc).__name__}: {exc}", now, job_id),
                )

    def _enforce_cache_limit(self) -> None:
        max_gb = float(get_setting("max_cache_gb", 15.0) or 15.0)
        max_bytes = int(max_gb * (1024 ** 3))
        with get_db() as conn:
            rows = conn.execute(
                "SELECT chunk_key, audio_path, size_bytes FROM audio_chunks ORDER BY created_at ASC"
            ).fetchall()
            total = sum(int(r["size_bytes"] or 0) for r in rows)
            for r in rows:
                if total <= max_bytes:
                    break
                Path(r["audio_path"]).unlink(missing_ok=True)
                conn.execute("DELETE FROM audio_chunks WHERE chunk_key = ?", (r["chunk_key"],))
                total -= int(r["size_bytes"] or 0)


audiobook_queue = AudiobookQueueManager()

