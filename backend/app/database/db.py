"""SQLite persistence layer with integrity checking and corruption recovery."""

from __future__ import annotations

import json
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from app.core.config import settings


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_profiles (
    voice_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('preset', 'designed_narrator', 'cloned')),
    description TEXT NOT NULL,
    narrator_style TEXT,
    instruct_prompt TEXT,
    speaker_name TEXT,
    ref_audio_path TEXT,
    ref_text TEXT,
    prompt_cache_path TEXT,
    sample_audio_path TEXT,
    compatible_models_json TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    is_preferred INTEGER NOT NULL DEFAULT 0,
    consent_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
    book_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'Unknown Author',
    language TEXT DEFAULT 'en',
    description TEXT,
    publisher TEXT,
    cover_path TEXT,
    epub_path TEXT NOT NULL,
    file_hash TEXT NOT NULL UNIQUE,
    total_chapters INTEGER NOT NULL DEFAULT 0,
    total_words INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    collection_name TEXT,
    reading_progress_pct REAL NOT NULL DEFAULT 0.0,
    listening_progress_pct REAL NOT NULL DEFAULT 0.0,
    added_at TEXT NOT NULL,
    last_opened_at TEXT,
    last_played_at TEXT
);

CREATE TABLE IF NOT EXISTS chapters (
    chapter_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    href TEXT NOT NULL,
    title TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    text_hash TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, chapter_index);

CREATE TABLE IF NOT EXISTS reading_positions (
    book_id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    cfi TEXT,
    scroll_offset REAL NOT NULL DEFAULT 0.0,
    sentence_index INTEGER NOT NULL DEFAULT 0,
    audio_position_sec REAL NOT NULL DEFAULT 0.0,
    progress_pct REAL NOT NULL DEFAULT 0.0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookmarks (
    bookmark_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    cfi TEXT,
    sentence_index INTEGER,
    label TEXT NOT NULL,
    excerpt TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS highlights (
    highlight_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    cfi_range TEXT,
    selected_text TEXT NOT NULL,
    note TEXT,
    color TEXT NOT NULL DEFAULT 'amber',
    created_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audio_chunks (
    chunk_key TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    sentence_start INTEGER NOT NULL,
    sentence_end INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'wav',
    duration_sec REAL NOT NULL,
    sample_rate INTEGER NOT NULL,
    sentence_timings_json TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audio_book_chap ON audio_chunks(book_id, chapter_id, voice_id, model_id);

CREATE TABLE IF NOT EXISTS tts_jobs (
    job_id TEXT PRIMARY KEY,
    book_id TEXT,
    chapter_id TEXT,
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,
    total_chunks INTEGER NOT NULL DEFAULT 0,
    completed_chunks INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_samples (
    sample_id TEXT PRIMARY KEY,
    voice_id TEXT NOT NULL,
    voice_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    device_used TEXT NOT NULL,
    dtype_used TEXT NOT NULL,
    text TEXT NOT NULL,
    instruct TEXT,
    audio_path TEXT NOT NULL,
    audio_duration_sec REAL NOT NULL,
    generation_sec REAL NOT NULL,
    load_sec REAL NOT NULL,
    rtf REAL NOT NULL,
    peak_vram_mb REAL NOT NULL,
    ram_mb REAL NOT NULL,
    sample_rate INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
"""


DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "dark-charcoal",
    "startup_behavior": "home",
    "language": "English",
    "active_model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "preferred_voice_id": "narrator-deep-cinematic",
    "device_preference": "auto",
    "batch_size": 1,
    "max_cache_gb": 15.0,
    "audio_cache_format": "wav",
    "pregenerate_next_chapter": True,
    "local_only_mode": True,
    "telemetry_enabled": False,
    "reader": {
        "font_family": "Literata, Georgia, serif",
        "font_size": 19,
        "line_height": 1.72,
        "paragraph_spacing": 14,
        "reading_width": 720,
        "theme": "charcoal",
        "custom_bg": "#18181b",
        "custom_fg": "#e4e4e7",
        "auto_continue_chapter": True,
    },
}


def init_database(db_path: Path | None = None) -> Path:
    """Initialize SQLite schema and recover gracefully if corruption is detected."""
    target = Path(db_path or settings.db_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        try:
            conn = sqlite3.connect(str(target))
            row = conn.execute("PRAGMA quick_check;").fetchone()
            conn.close()
            if not row or row[0] != "ok":
                raise sqlite3.DatabaseError(f"SQLite quick_check failed: {row}")
        except sqlite3.DatabaseError:
            backup = target.with_suffix(f".corrupt.{int(time.time())}.bak")
            shutil.move(str(target), str(backup))

    conn = sqlite3.connect(str(target))
    try:
        conn.executescript(SCHEMA_SQL)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
                (k, json.dumps(v), now),
            )
        conn.commit()
    finally:
        conn.close()
    return target


@contextmanager
def get_db(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection configured with row_factory and foreign keys."""
    target = Path(db_path or settings.db_path)
    conn = sqlite3.connect(str(target), check_same_thread=False, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_setting(key: str, default: Any = None, db_path: Path | None = None) -> Any:
    with get_db(db_path) as conn:
        row = conn.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        return json.loads(row["value_json"])


def set_setting(key: str, value: Any, db_path: Path | None = None) -> None:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with get_db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
            """,
            (key, json.dumps(value), now),
        )


def get_all_settings(db_path: Path | None = None) -> dict[str, Any]:
    with get_db(db_path) as conn:
        rows = conn.execute("SELECT key, value_json FROM app_settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for r in rows:
        out[r["key"]] = json.loads(r["value_json"])
    return out

