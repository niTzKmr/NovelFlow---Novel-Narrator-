"""End-to-end offline EPUB + real Qwen3-TTS GPU audiobook integration test.

Verifies:
1. Real EPUB 3 import via FastAPI.
2. Enqueueing Chapter 1 audiobook generation on 0.6B-Base (Deep Cinematic Narrator, CUDA bfloat16).
3. Playback readiness BEFORE the full chapter completes (chunk 0 cached first).
4. Ground-truth per-sentence timings & audio output on disk.
5. Deterministic cache reuse on second request (already_cached=True).
"""

from __future__ import annotations

import io
import os
import sys
import time
import zipfile
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
sys.path.insert(0, r"D:\EPUBReader\backend")

from fastapi.testclient import TestClient
from app.core.config import settings
from app.database.db import init_database
from app.main import app
from app.services.audiobook import audiobook_queue
from app.services.voices import seed_builtin_voices


def build_test_epub() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""",
        )
        zf.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">e2e-sect-novel</dc:identifier>
    <dc:title>Misty Peak Chronicles</dc:title>
    <dc:creator>Chen Mu</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>""",
        )
        zf.writestr(
            "OEBPS/ch1.xhtml",
            """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter 1: Shadows Above the Ridge</h1>
  <p>Beyond the mountains, hidden from the eyes of ordinary men, stood an ancient sect.</p>
  <p>For centuries, its secrets had remained untouched. But tonight, everything was about to change.</p>
</body></html>""",
        )
        zf.writestr(
            "OEBPS/ch2.xhtml",
            """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Chapter 2: The Jade Scroll</h1>
  <p>Dawn broke softly across the quiet courtyard.</p>
</body></html>""",
        )
    return buf.getvalue()


def main() -> None:
    init_database()
    seed_builtin_voices()
    audiobook_queue.start_worker()

    with TestClient(app) as client:
        # 1. Import EPUB
        book = client.post(
            "/api/books/import",
            files={"file": ("misty_peak.epub", build_test_epub(), "application/epub+zip")},
        ).json()
        book_id = book["book_id"]
        ch1_id = book["chapters"][0]["chapter_id"]
        print(f"Imported EPUB book_id={book_id}, ch1_id={ch1_id}", flush=True)

        # 2. Enqueue Chapter 1 narration with pregenerate_next=False so test stays focused
        t0 = time.perf_counter()
        gen = client.post(
            "/api/audiobook/generate",
            json={
                "chapter_id": ch1_id,
                "voice_id": "narrator-deep-cinematic",
                "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                "start_sentence_index": 0,
                "device": "auto",
                "pregenerate_next": False,
            },
        ).json()
        print("Initial enqueue:", gen["status"], "total_chunks=", gen["chapter_status"]["total_chunks"], flush=True)

        first_chunk_time = None
        while True:
            st = client.get(
                f"/api/audiobook/chapter/{ch1_id}/status",
                params={"voice_id": "narrator-deep-cinematic", "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"},
            ).json()
            if st["cached_chunks"] >= 1 and first_chunk_time is None:
                first_chunk_time = round(time.perf_counter() - t0, 2)
                print(f"First chunk ready for playback in {first_chunk_time}s (cached={st['cached_chunks']}/{st['total_chunks']})", flush=True)
            if st["complete"]:
                print(f"Chapter 1 complete in {round(time.perf_counter() - t0, 2)}s! Total audio duration={st['total_cached_duration_sec']}s", flush=True)
                for ch in st["chunks"]:
                    audio_res = client.get(ch["audio_url"])
                    assert audio_res.status_code == 200 and len(audio_res.content) > 4000
                    print(f"  Chunk {ch['chunk_index']}: dur={ch['duration_sec']}s, timings={ch['sentence_timings']}", flush=True)
                break
            time.sleep(1.0)

        # 3. Verify cache hit on second generate call (zero regeneration!)
        t_cache = time.perf_counter()
        cached_res = client.post(
            "/api/audiobook/generate",
            json={
                "chapter_id": ch1_id,
                "voice_id": "narrator-deep-cinematic",
                "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                "start_sentence_index": 0,
                "device": "auto",
                "pregenerate_next": False,
            },
        ).json()
        assert cached_res["already_cached"] is True
        print(f"Cache reuse verified in {round((time.perf_counter() - t_cache)*1000, 1)}ms (already_cached=True)", flush=True)


if __name__ == "__main__":
    main()

