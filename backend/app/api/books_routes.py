"""FastAPI routes for EPUB import, library management, chapter reading, search, progress, bookmarks, and highlights."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.epub.parser import EpubParseError
from app.services.library import (
    add_bookmark,
    add_highlight,
    delete_book,
    delete_bookmark,
    delete_highlight,
    get_book_detail,
    get_chapter_content,
    import_epub_bytes,
    list_books,
    list_bookmarks,
    list_highlights,
    save_reading_position,
    search_in_book,
    update_book_meta,
)


router = APIRouter(prefix="/api", tags=["books"])


class BookMetaPatch(BaseModel):
    is_favorite: Optional[bool] = None
    collection_name: Optional[str] = None


class ReadingProgressIn(BaseModel):
    chapter_id: str
    chapter_index: int
    cfi: Optional[str] = None
    scroll_offset: float = 0.0
    sentence_index: int = 0
    audio_position_sec: float = 0.0
    progress_pct: float = 0.0
    is_audio_playing: bool = False


class BookmarkCreate(BaseModel):
    chapter_id: str
    chapter_index: int
    label: str = Field(min_length=1, max_length=160)
    cfi: Optional[str] = None
    sentence_index: Optional[int] = None
    excerpt: Optional[str] = None


class HighlightCreate(BaseModel):
    chapter_id: str
    chapter_index: int
    selected_text: str = Field(min_length=1, max_length=4000)
    note: Optional[str] = None
    color: str = "amber"
    cfi_range: Optional[str] = None


@router.post("/books/import")
async def api_import_book(file: UploadFile = File(...)) -> dict[str, Any]:
    fname = file.filename or "book.epub"
    if not fname.lower().endswith(".epub"):
        raise HTTPException(status_code=400, detail="Only .epub files are supported.")
    data = await file.read()
    try:
        return import_epub_bytes(data, fname)
    except EpubParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to import EPUB: {type(exc).__name__}: {exc}") from exc


@router.get("/books")
def api_list_books(
    section: Optional[str] = None,
    collection: Optional[str] = None,
    q: Optional[str] = None,
) -> list[dict[str, Any]]:
    return list_books(section=section, collection=collection, query=q)


@router.get("/books/{book_id}")
def api_get_book(book_id: str) -> dict[str, Any]:
    try:
        return get_book_detail(book_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/books/{book_id}")
def api_patch_book(book_id: str, req: BookMetaPatch) -> dict[str, Any]:
    try:
        return update_book_meta(book_id, is_favorite=req.is_favorite, collection_name=req.collection_name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/books/{book_id}")
def api_delete_book(book_id: str) -> dict[str, Any]:
    try:
        return delete_book(book_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/books/{book_id}/cover")
def api_book_cover(book_id: str) -> FileResponse:
    bdir = settings.books_dir / book_id
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        candidate = bdir / f"cover{ext}"
        if candidate.exists():
            mtype = mimetypes.guess_type(str(candidate))[0] or "image/jpeg"
            return FileResponse(candidate, media_type=mtype)
    raise HTTPException(status_code=404, detail="Cover image not found.")


@router.get("/books/{book_id}/epub")
def api_book_epub(book_id: str) -> FileResponse:
    epub_file = settings.books_dir / book_id / "book.epub"
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB file not found.")
    return FileResponse(epub_file, media_type="application/epub+zip", filename=f"{book_id}.epub")


@router.get("/books/{book_id}/assets/{asset_path:path}")
def api_book_asset(book_id: str, asset_path: str) -> FileResponse:
    root = (settings.books_dir / book_id / "assets").resolve()
    target = (root / asset_path.lstrip("/")).resolve()
    if root != target and root not in target.parents:
        raise HTTPException(status_code=403, detail="Forbidden asset path.")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Asset not found.")
    mtype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return FileResponse(target, media_type=mtype)


@router.get("/chapters/{chapter_id}")
def api_get_chapter(chapter_id: str) -> dict[str, Any]:
    try:
        return get_chapter_content(chapter_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/books/{book_id}/search")
def api_search_book(book_id: str, q: str) -> list[dict[str, Any]]:
    try:
        return search_in_book(book_id, q)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/books/{book_id}/progress")
def api_save_progress(book_id: str, req: ReadingProgressIn) -> dict[str, Any]:
    try:
        return save_reading_position(
            book_id=book_id,
            chapter_id=req.chapter_id,
            chapter_index=req.chapter_index,
            cfi=req.cfi,
            scroll_offset=req.scroll_offset,
            sentence_index=req.sentence_index,
            audio_position_sec=req.audio_position_sec,
            progress_pct=req.progress_pct,
            is_audio_playing=req.is_audio_playing,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/books/{book_id}/bookmarks")
def api_list_bookmarks(book_id: str) -> list[dict[str, Any]]:
    return list_bookmarks(book_id)


@router.post("/books/{book_id}/bookmarks")
def api_create_bookmark(book_id: str, req: BookmarkCreate) -> dict[str, Any]:
    return add_bookmark(
        book_id=book_id,
        chapter_id=req.chapter_id,
        chapter_index=req.chapter_index,
        label=req.label,
        cfi=req.cfi,
        sentence_index=req.sentence_index,
        excerpt=req.excerpt,
    )


@router.delete("/bookmarks/{bookmark_id}")
def api_delete_bookmark(bookmark_id: str) -> dict[str, Any]:
    return delete_bookmark(bookmark_id)


@router.get("/books/{book_id}/highlights")
def api_list_highlights(book_id: str) -> list[dict[str, Any]]:
    return list_highlights(book_id)


@router.post("/books/{book_id}/highlights")
def api_create_highlight(book_id: str, req: HighlightCreate) -> dict[str, Any]:
    return add_highlight(
        book_id=book_id,
        chapter_id=req.chapter_id,
        chapter_index=req.chapter_index,
        selected_text=req.selected_text,
        note=req.note,
        color=req.color,
        cfi_range=req.cfi_range,
    )


@router.delete("/highlights/{highlight_id}")
def api_delete_highlight(highlight_id: str) -> dict[str, Any]:
    return delete_highlight(highlight_id)

