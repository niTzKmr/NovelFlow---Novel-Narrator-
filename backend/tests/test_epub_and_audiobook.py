"""Tests for EPUB 2 & 3 parsing, library persistence, sentence segmentation, caching, and restart recovery."""

from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.database.db import init_database
from app.main import app
from app.services.audiobook import AudiobookQueueManager, _encode_audio_file, _split_timings_by_acoustic_pauses, make_chunk_key
from app.services.voices import seed_builtin_voices
from app.tts.segmenter import SentenceItem, build_chunk_plans, split_paragraph_sentences


def _make_sample_epub(epub3: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""",
        )
        # 1x1 valid PNG pixel
        png_bytes = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        zf.writestr("OEBPS/images/cover.png", png_bytes)
        zf.writestr("OEBPS/images/sigil.png", png_bytes)

        nav_manifest = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' if epub3 else ""
        zf.writestr(
            "OEBPS/content.opf",
            f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="{'3.0' if epub3 else '2.0'}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">novelflow-test-001</dc:identifier>
    <dc:title>Chronicles of the Jade Peak</dc:title>
    <dc:creator>Lin Wei</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>A cultivation webnovel test book with Unicode and formatting.</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    {nav_manifest}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="sigil-img" href="images/sigil.png" media-type="image/png"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>""",
        )
        if epub3:
            zf.writestr(
                "OEBPS/nav.xhtml",
                """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chapter 1: The Ancient Sect</a></li>
  <li><a href="ch2.xhtml">Chapter 2: Jade Cultivation</a></li>
</ol></nav></body></html>""",
            )
        zf.writestr(
            "OEBPS/toc.ncx",
            """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Chapter 1: The Ancient Sect</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Chapter 2: Jade Cultivation</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>""",
        )
        zf.writestr(
            "OEBPS/ch1.xhtml",
            """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1>Chapter 1: The Ancient Sect</h1>
  <p>Dr. Shen looked at the <em>azure</em> crest on the gate. Beyond the mountains stood Qingyun Sect (青云宗)!</p>
  <p><strong>[System Notice]</strong> Qi density reached 3.14 units. Mr. Lin nodded slowly.</p>
  <img src="images/sigil.png" alt="Sect Sigil"/>
</body></html>""",
        )
        zf.writestr(
            "OEBPS/ch2.xhtml",
            """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1>Chapter 2: Jade Cultivation</h1>
  <p>Tonight, everything changed under the moonlight. The elder smiled calmly.</p>
</body></html>""",
        )
    return buf.getvalue()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    db_file = tmp_path / "test_app.sqlite3"
    for attr, sub in (
        ("books_dir", "books"),
        ("audio_dir", "audio"),
        ("voices_dir", "voices"),
        ("cache_dir", "cache"),
    ):
        d = tmp_path / sub
        d.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(settings, attr, d)
    monkeypatch.setattr(settings, "db_path", db_file)
    init_database(db_file)
    seed_builtin_voices()
    return TestClient(app)


def test_sentence_segmentation_handles_abbreviations_decimals_and_unicode() -> None:
    para = "Dr. Shen read 3.14 scrolls in Qingyun Sect (青云宗). Mr. Lin asked: \"Are we ready?\" Yes!"
    sents = split_paragraph_sentences(para)
    assert len(sents) == 3
    assert "Dr. Shen read 3.14 scrolls" in sents[0]
    assert "Mr. Lin asked:" in sents[1]
    assert sents[2] == "Yes!"


@pytest.mark.parametrize("epub3", [True, False])
def test_epub_import_metadata_search_progress_and_annotations(client: TestClient, epub3: bool) -> None:
    raw = _make_sample_epub(epub3=epub3)
    res = client.post(
        "/api/books/import",
        files={"file": ("jade.epub", raw, "application/epub+zip")},
    )
    assert res.status_code == 200
    book = res.json()
    bid = book["book_id"]
    assert book["title"] == "Chronicles of the Jade Peak"
    assert book["author"] == "Lin Wei"
    assert book["total_chapters"] == 2
    assert book["cover_url"] is not None

    # Cover, raw EPUB, and embedded image asset serve cleanly
    assert client.get(book["cover_url"]).status_code == 200
    assert client.get(book["epub_url"]).status_code == 200
    assert client.get(f"/api/books/{bid}/assets/OEBPS/images/sigil.png").status_code == 200

    # Chapter content preserves italics, bold, Unicode, and exact sentence spans
    ch1_id = book["chapters"][0]["chapter_id"]
    ch1 = client.get(f"/api/chapters/{ch1_id}").json()
    assert f"/api/books/{bid}/assets/OEBPS/images/sigil.png" in ch1["html"]
    assert "<em>azure</em>" in ch1["html"]
    assert "青云宗" in ch1["html"]
    assert len(ch1["sentences"]) >= 4

    # Search across book
    hits = client.get(f"/api/books/{bid}/search", params={"q": "Qingyun"}).json()
    assert len(hits) == 1
    assert hits[0]["chapter_index"] == 0

    # Save & persist reading position, favorite, collection, bookmarks, highlights
    prog = client.put(
        f"/api/books/{bid}/progress",
        json={"chapter_id": ch1_id, "chapter_index": 0, "sentence_index": 2, "audio_position_sec": 4.2, "progress_pct": 42.5, "is_audio_playing": True},
    )
    assert prog.status_code == 200
    reloaded = client.get(f"/api/books/{bid}").json()
    assert reloaded["position"]["sentence_index"] == 2
    assert reloaded["reading_progress_pct"] == 42.5

    client.patch(f"/api/books/{bid}", json={"is_favorite": True, "collection_name": "Xianxia"})
    favs = client.get("/api/books", params={"section": "favorites", "collection": "Xianxia"}).json()
    assert len(favs) == 1

    bm = client.post(f"/api/books/{bid}/bookmarks", json={"chapter_id": ch1_id, "chapter_index": 0, "label": "Sect Arrival", "sentence_index": 1}).json()
    assert len(client.get(f"/api/books/{bid}/bookmarks").json()) == 1
    assert client.delete(f"/api/bookmarks/{bm['bookmark_id']}").status_code == 200

    hl = client.post(f"/api/books/{bid}/highlights", json={"chapter_id": ch1_id, "chapter_index": 0, "selected_text": "Qingyun Sect", "note": "Main sect"}).json()
    assert len(client.get(f"/api/books/{bid}/highlights").json()) == 1
    assert client.delete(f"/api/highlights/{hl['highlight_id']}").status_code == 200


def test_corrupt_epub_returns_clean_400(client: TestClient) -> None:
    res = client.post(
        "/api/books/import",
        files={"file": ("broken.epub", b"not-a-zip-archive", "application/epub+zip")},
    )
    assert res.status_code == 400
    assert "corrupt" in res.json()["detail"].lower()


def test_audio_chunk_encoding_cache_reuse_and_restart_recovery(client: TestClient, tmp_path: Path) -> None:
    raw = _make_sample_epub(epub3=True)
    book = client.post("/api/books/import", files={"file": ("jade.epub", raw, "application/epub+zip")}).json()
    ch1_id = book["chapters"][0]["chapter_id"]

    # Simulate an interrupted running TTS job before restart
    with sqlite3.connect(str(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO tts_jobs (job_id, book_id, chapter_id, voice_id, model_id, status, total_chunks, completed_chunks, created_at, updated_at)
            VALUES ('job-stale', ?, ?, 'narrator-deep-cinematic', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', 'running', 5, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
            """,
            (book["book_id"], ch1_id),
        )
        conn.commit()

    qm = AudiobookQueueManager()
    qm._recover_interrupted_jobs()
    recovered = qm.get_job("job-stale")
    assert recovered["status"] == "interrupted"

    # Encode real audio chunk to WAV & verify exact ground-truth timings + MP3 via bundled ffmpeg
    sr = 24000
    w1 = np.zeros(int(sr * 1.2), dtype=np.float32)
    w2 = np.zeros(int(sr * 0.8), dtype=np.float32)
    wav_path, timings, dur = _encode_audio_file([w1, w2], sr, tmp_path / "chunk0.wav", "wav")
    assert wav_path.exists()
    assert len(timings) == 2
    assert timings[0]["start_sec"] == 0.0
    assert abs(timings[0]["end_sec"] - 1.2) < 0.01
    assert abs(timings[1]["start_sec"] - 1.34) < 0.01  # includes 140ms breath pause
    assert dur > 2.0

    mp3_path, _, _ = _encode_audio_file([w1], sr, tmp_path / "chunk0.mp3", "mp3")
    assert mp3_path.exists() and mp3_path.stat().st_size > 100

    # Verify deterministic cache key matching & chapter status detection
    status = qm.get_chapter_audio_status(ch1_id, "narrator-deep-cinematic", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    assert status["total_chunks"] >= 2
    first_chunk = status["chunks"][0]
    with sqlite3.connect(str(settings.db_path)) as conn:
        conn.execute(
            """
            INSERT INTO audio_chunks (
                chunk_key, book_id, chapter_id, chunk_index, sentence_start, sentence_end,
                text_hash, voice_id, model_id, audio_path, format, duration_sec,
                sample_rate, sentence_timings_json, size_bytes, created_at
            ) VALUES (?, ?, ?, 0, ?, ?, 'h', 'narrator-deep-cinematic', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', ?, 'wav', 1.2, 24000, '[]', 100, '2026-01-01T00:00:00Z')
            """,
            (first_chunk["chunk_key"], book["book_id"], ch1_id, first_chunk["sentence_start"], first_chunk["sentence_end"], str(wav_path)),
        )
        conn.commit()

    status_after = client.get(f"/api/audiobook/chapter/{ch1_id}/status").json()
    assert status_after["cached_chunks"] == 1
    assert status_after["chunks"][0]["status"] == "cached"
    assert client.get(status_after["chunks"][0]["audio_url"]).status_code == 200


def test_short_fragment_coalescing_and_acoustic_pause_alignment() -> None:
    sents = [
        SentenceItem(0, 0, "Wait."),
        SentenceItem(1, 0, "He froze at the gate."),
        SentenceItem(2, 1, "Beyond the mountains stood an ancient sect whose mysteries spanned a thousand years."),
    ]
    plans = build_chunk_plans(sents, batch_size=1)
    assert len(plans) == 2
    assert plans[0].sentence_start == 0 and plans[0].sentence_end == 1

    # Construct 2.5s synthetic waveform with tone 0..0.45s, real silence 0.45..0.75s, tone 0.75..2.5s
    sr = 24000
    t1 = np.full(int(sr * 0.45), 0.25, dtype=np.float32)
    pause = np.zeros(int(sr * 0.30), dtype=np.float32)
    t2 = np.full(int(sr * 1.75), 0.25, dtype=np.float32)
    wav = np.concatenate([t1, pause, t2])
    timings = _split_timings_by_acoustic_pauses(wav, sr, plans[0].sentences)
    assert len(timings) == 2
    assert 0.40 <= timings[0]["end_sec"] <= 0.80
    assert timings[1]["start_sec"] == timings[0]["end_sec"]

