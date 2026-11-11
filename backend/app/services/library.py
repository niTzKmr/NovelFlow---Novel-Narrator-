"""Book library, EPUB storage, chapter search, reading positions, bookmarks, and highlights."""

from __future__ import annotations

import hashlib
import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from app.core.config import settings
from app.database.db import get_db
from app.epub.parser import EpubParseError, parse_epub_file


def _book_dir(book_id: str) -> Path:
    d = settings.books_dir / book_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_asset_target(assets_root: Path, rel_path: str) -> Path:
    rel = Path(rel_path.replace("\\", "/").lstrip("/"))
    target = (assets_root / rel).resolve()
    root_resolved = assets_root.resolve()
    if root_resolved != target and root_resolved not in target.parents:
        raise ValueError("Invalid asset path traversal.")
    return target


def import_epub_bytes(epub_bytes: bytes, filename: str) -> dict[str, Any]:
    """Import an EPUB file, deduplicate by SHA-256, extract metadata, assets, chapters, and sentences."""
    if not epub_bytes:
        raise EpubParseError("Uploaded file is empty.")

    file_hash = hashlib.sha256(epub_bytes).hexdigest()
    with get_db() as conn:
        existing = conn.execute("SELECT book_id FROM books WHERE file_hash = ?", (file_hash,)).fetchone()
        if existing:
            return get_book_detail(existing["book_id"])

    book_id = f"book-{uuid.uuid4().hex[:12]}"
    bdir = _book_dir(book_id)
    epub_path = bdir / "book.epub"
    epub_path.write_bytes(epub_bytes)

    try:
        parsed = parse_epub_file(epub_path, book_id=book_id)
    except Exception:
        shutil.rmtree(bdir, ignore_errors=True)
        raise

    cover_path_str: Optional[str] = None
    if parsed.cover_bytes:
        cpath = bdir / f"cover{parsed.cover_ext}"
        cpath.write_bytes(parsed.cover_bytes)
        cover_path_str = str(cpath)

    assets_dir = bdir / "assets"
    for rel, raw in parsed.assets.items():
        try:
            target = _safe_asset_target(assets_dir, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        except ValueError:
            continue

    chapters_dir = bdir / "chapters"
    chapters_dir.mkdir(parents=True, exist_ok=True)

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    total_words = sum(c.word_count for c in parsed.chapters)

    try:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO books (
                    book_id, title, author, language, description, publisher,
                    cover_path, epub_path, file_hash, total_chapters, total_words,
                    is_favorite, collection_name, reading_progress_pct, listening_progress_pct,
                    added_at, last_opened_at, last_played_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0.0, 0.0, ?, NULL, NULL)
                """,
                (
                    book_id,
                    parsed.title,
                    parsed.author,
                    parsed.language,
                    parsed.description,
                    parsed.publisher,
                    cover_path_str,
                    str(epub_path),
                    file_hash,
                    len(parsed.chapters),
                    total_words,
                    now,
                ),
            )
            for ch in parsed.chapters:
                chapter_id = f"{book_id}-ch{ch.chapter_index:04d}"
                ch_json = chapters_dir / f"ch{ch.chapter_index:04d}.json"
                ch_json.write_text(
                    json.dumps(
                        {
                            "chapter_id": chapter_id,
                            "book_id": book_id,
                            "chapter_index": ch.chapter_index,
                            "href": ch.href,
                            "title": ch.title,
                            "html": ch.sanitized_html,
                            "sentences": [
                                {
                                    "sentence_index": s.sentence_index,
                                    "paragraph_index": s.paragraph_index,
                                    "text": s.text,
                                }
                                for s in ch.sentences
                            ],
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                conn.execute(
                    """
                    INSERT INTO chapters (
                        chapter_id, book_id, chapter_index, href, title, word_count, char_count, text_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chapter_id,
                        book_id,
                        ch.chapter_index,
                        ch.href,
                        ch.title,
                        ch.word_count,
                        ch.char_count,
                        ch.text_hash,
                    ),
                )
    except Exception:
        shutil.rmtree(bdir, ignore_errors=True)
        raise

    return get_book_detail(book_id)


def _book_row_to_dict(row: Any) -> dict[str, Any]:
    bid = row["book_id"]
    has_cover = bool(row["cover_path"] and Path(row["cover_path"]).exists())
    return {
        "book_id": bid,
        "title": row["title"],
        "author": row["author"],
        "language": row["language"],
        "description": row["description"],
        "publisher": row["publisher"],
        "cover_url": f"/api/books/{bid}/cover" if has_cover else None,
        "epub_url": f"/api/books/{bid}/epub",
        "total_chapters": row["total_chapters"],
        "total_words": row["total_words"],
        "is_favorite": bool(row["is_favorite"]),
        "collection_name": row["collection_name"],
        "reading_progress_pct": round(float(row["reading_progress_pct"]), 1),
        "listening_progress_pct": round(float(row["listening_progress_pct"]), 1),
        "added_at": row["added_at"],
        "last_opened_at": row["last_opened_at"],
        "last_played_at": row["last_played_at"],
    }


def list_books(
    section: Optional[str] = None,
    collection: Optional[str] = None,
    query: Optional[str] = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM books WHERE 1=1"
    params: list[Any] = []

    if section == "continue_reading":
        sql += " AND last_opened_at IS NOT NULL AND reading_progress_pct < 99.5"
    elif section == "favorites":
        sql += " AND is_favorite = 1"
    elif section == "recently_played":
        sql += " AND last_played_at IS NOT NULL"
    elif section == "history":
        sql += " AND last_opened_at IS NOT NULL"

    if collection:
        sql += " AND collection_name = ?"
        params.append(collection)

    if query and query.strip():
        q = f"%{query.strip().lower()}%"
        sql += " AND (LOWER(title) LIKE ? OR LOWER(author) LIKE ?)"
        params.extend([q, q])

    if section == "recently_played":
        sql += " ORDER BY last_played_at DESC"
    elif section in ("continue_reading", "history"):
        sql += " ORDER BY last_opened_at DESC"
    else:
        sql += " ORDER BY added_at DESC"

    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_book_row_to_dict(r) for r in rows]


def get_book_detail(book_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM books WHERE book_id = ?", (book_id,)).fetchone()
        if not row:
            raise KeyError(f"Book '{book_id}' not found.")
        chapters = conn.execute(
            "SELECT * FROM chapters WHERE book_id = ? ORDER BY chapter_index ASC", (book_id,)
        ).fetchall()
        pos = conn.execute(
            "SELECT * FROM reading_positions WHERE book_id = ?", (book_id,)
        ).fetchone()

    book = _book_row_to_dict(row)
    book["chapters"] = [
        {
            "chapter_id": c["chapter_id"],
            "chapter_index": c["chapter_index"],
            "href": c["href"],
            "title": c["title"],
            "word_count": c["word_count"],
            "char_count": c["char_count"],
            "text_hash": c["text_hash"],
        }
        for c in chapters
    ]
    book["position"] = (
        {
            "chapter_id": pos["chapter_id"],
            "chapter_index": pos["chapter_index"],
            "cfi": pos["cfi"],
            "scroll_offset": pos["scroll_offset"],
            "sentence_index": pos["sentence_index"],
            "audio_position_sec": pos["audio_position_sec"],
            "progress_pct": pos["progress_pct"],
            "updated_at": pos["updated_at"],
        }
        if pos
        else None
    )
    return book


def update_book_meta(book_id: str, is_favorite: Optional[bool] = None, collection_name: Optional[str] = None) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT book_id FROM books WHERE book_id = ?", (book_id,)).fetchone()
        if not row:
            raise KeyError(f"Book '{book_id}' not found.")
        if is_favorite is not None:
            conn.execute("UPDATE books SET is_favorite = ? WHERE book_id = ?", (1 if is_favorite else 0, book_id))
        if collection_name is not None:
            val = collection_name.strip() or None
            conn.execute("UPDATE books SET collection_name = ? WHERE book_id = ?", (val, book_id))
    return get_book_detail(book_id)


def delete_book(book_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT book_id FROM books WHERE book_id = ?", (book_id,)).fetchone()
        if not row:
            raise KeyError(f"Book '{book_id}' not found.")
        conn.execute("DELETE FROM books WHERE book_id = ?", (book_id,))
    shutil.rmtree(settings.books_dir / book_id, ignore_errors=True)
    shutil.rmtree(settings.audio_dir / book_id, ignore_errors=True)
    return {"deleted": True, "book_id": book_id}


def get_chapter_content(chapter_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM chapters WHERE chapter_id = ?", (chapter_id,)).fetchone()
    if not row:
        raise KeyError(f"Chapter '{chapter_id}' not found.")

    book_id = row["book_id"]
    ch_json = settings.books_dir / book_id / "chapters" / f"ch{row['chapter_index']:04d}.json"
    if not ch_json.exists():
        raise FileNotFoundError(f"Chapter content file missing: {ch_json}")

    payload = json.loads(ch_json.read_text(encoding="utf-8"))
    payload["word_count"] = row["word_count"]
    payload["char_count"] = row["char_count"]
    payload["text_hash"] = row["text_hash"]
    return payload


def search_in_book(book_id: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
    q = query.strip()
    if not q:
        return []
    q_low = q.lower()
    detail = get_book_detail(book_id)
    matches: list[dict[str, Any]] = []

    for ch in detail["chapters"]:
        ch_data = get_chapter_content(ch["chapter_id"])
        for sent in ch_data["sentences"]:
            txt = sent["text"]
            idx = txt.lower().find(q_low)
            if idx != -1:
                matches.append(
                    {
                        "chapter_id": ch["chapter_id"],
                        "chapter_index": ch["chapter_index"],
                        "chapter_title": ch["title"],
                        "sentence_index": sent["sentence_index"],
                        "paragraph_index": sent["paragraph_index"],
                        "snippet": txt,
                    }
                )
                if len(matches) >= limit:
                    return matches
    return matches


def save_reading_position(
    book_id: str,
    chapter_id: str,
    chapter_index: int,
    cfi: Optional[str] = None,
    scroll_offset: float = 0.0,
    sentence_index: int = 0,
    audio_position_sec: float = 0.0,
    progress_pct: float = 0.0,
    is_audio_playing: bool = False,
) -> dict[str, Any]:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    clamped_pct = max(0.0, min(100.0, float(progress_pct)))
    with get_db() as conn:
        row = conn.execute("SELECT book_id FROM books WHERE book_id = ?", (book_id,)).fetchone()
        if not row:
            raise KeyError(f"Book '{book_id}' not found.")
        conn.execute(
            """
            INSERT INTO reading_positions (
                book_id, chapter_id, chapter_index, cfi, scroll_offset,
                sentence_index, audio_position_sec, progress_pct, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET
                chapter_id=excluded.chapter_id,
                chapter_index=excluded.chapter_index,
                cfi=COALESCE(excluded.cfi, reading_positions.cfi),
                scroll_offset=excluded.scroll_offset,
                sentence_index=excluded.sentence_index,
                audio_position_sec=excluded.audio_position_sec,
                progress_pct=excluded.progress_pct,
                updated_at=excluded.updated_at
            """,
            (
                book_id,
                chapter_id,
                chapter_index,
                cfi,
                scroll_offset,
                sentence_index,
                audio_position_sec,
                clamped_pct,
                now,
            ),
        )
        if is_audio_playing:
            conn.execute(
                """
                UPDATE books
                SET reading_progress_pct = ?, listening_progress_pct = ?, last_opened_at = ?, last_played_at = ?
                WHERE book_id = ?
                """,
                (clamped_pct, clamped_pct, now, now, book_id),
            )
        else:
            conn.execute(
                """
                UPDATE books
                SET reading_progress_pct = ?, last_opened_at = ?
                WHERE book_id = ?
                """,
                (clamped_pct, now, book_id),
            )
    return {"saved": True, "progress_pct": clamped_pct, "updated_at": now}


def list_bookmarks(book_id: str) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM bookmarks WHERE book_id = ? ORDER BY chapter_index ASC, created_at DESC",
            (book_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def add_bookmark(
    book_id: str,
    chapter_id: str,
    chapter_index: int,
    label: str,
    cfi: Optional[str] = None,
    sentence_index: Optional[int] = None,
    excerpt: Optional[str] = None,
) -> dict[str, Any]:
    bid = f"bm-{uuid.uuid4().hex[:10]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO bookmarks (
                bookmark_id, book_id, chapter_id, chapter_index, cfi, sentence_index, label, excerpt, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (bid, book_id, chapter_id, chapter_index, cfi, sentence_index, label.strip(), excerpt, now),
        )
        row = conn.execute("SELECT * FROM bookmarks WHERE bookmark_id = ?", (bid,)).fetchone()
    return dict(row)


def delete_bookmark(bookmark_id: str) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute("DELETE FROM bookmarks WHERE bookmark_id = ?", (bookmark_id,))
    return {"deleted": True, "bookmark_id": bookmark_id}


def list_highlights(book_id: str) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM highlights WHERE book_id = ? ORDER BY chapter_index ASC, created_at DESC",
            (book_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def add_highlight(
    book_id: str,
    chapter_id: str,
    chapter_index: int,
    selected_text: str,
    note: Optional[str] = None,
    color: str = "amber",
    cfi_range: Optional[str] = None,
) -> dict[str, Any]:
    hid = f"hl-{uuid.uuid4().hex[:10]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO highlights (
                highlight_id, book_id, chapter_id, chapter_index, cfi_range, selected_text, note, color, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (hid, book_id, chapter_id, chapter_index, cfi_range, selected_text.strip(), note, color, now),
        )
        row = conn.execute("SELECT * FROM highlights WHERE highlight_id = ?", (hid,)).fetchone()
    return dict(row)


def delete_highlight(highlight_id: str) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute("DELETE FROM highlights WHERE highlight_id = ?", (highlight_id,))
    return {"deleted": True, "highlight_id": highlight_id}

