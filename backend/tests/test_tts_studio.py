"""Comprehensive tests for Standalone Text-to-Speech Studio (isolated storage, queue, partial recovery & flags)."""

from __future__ import annotations

import io
import sqlite3
import threading
import time
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.core.config import settings
from app.database.db import init_database
from app.main import app
from app.services.voices import seed_builtin_voices
from app.tts.engine import SynthesisResult, tts_engine


def _make_sample_epub() -> bytes:
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
    <dc:identifier id="uid">studio-epub-1</dc:identifier>
    <dc:title>Studio Isolation Test Book</dc:title>
    <dc:creator>Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>""",
        )
        zf.writestr(
            "OEBPS/nav.xhtml",
            """<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Ch 1</a></li></ol></nav></body></html>""",
        )
        zf.writestr(
            "OEBPS/ch1.xhtml",
            """<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>First audiobook sentence. Second audiobook sentence.</p></body></html>""",
        )
    return buf.getvalue()


@pytest.fixture()
def studio_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    storage_dir = tmp_path / "storage"
    books_dir = storage_dir / "books"
    audio_dir = storage_dir / "audio"
    voices_dir = storage_dir / "voices"
    cache_dir = storage_dir / "cache"
    db_file = storage_dir / "db" / "test.sqlite3"
    for attr, d in (
        ("storage_dir", storage_dir),
        ("books_dir", books_dir),
        ("audio_dir", audio_dir),
        ("voices_dir", voices_dir),
        ("cache_dir", cache_dir),
    ):
        d.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(settings, attr, d)
    monkeypatch.setattr(settings, "db_path", db_file)
    init_database(db_file)
    seed_builtin_voices()

    refs_dir = voices_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)
    for vid in ("narrator-deep-cinematic", "narrator-warm-conversational", "narrator-expressive-audiobook"):
        sf.write(str(refs_dir / f"{vid}.wav"), np.zeros(12000, dtype=np.float32), 24000)

    monkeypatch.setattr(
        "app.services.tts_studio.ensure_narrator_reference_clip",
        lambda voice_id, device="auto": refs_dir / f"{voice_id}.wav",
    )
    monkeypatch.setattr(
        "app.services.audiobook.ensure_narrator_reference_clip",
        lambda voice_id, device="auto": refs_dir / f"{voice_id}.wav",
    )

    state = {
        "calls": [],
        "active": 0,
        "max_concurrent": 0,
        "lock": threading.Lock(),
        "fail_on_call_idx": None,
        "delay_sec": 0.01,
    }

    def _make_fake_res(model_id: str, count: int) -> SynthesisResult:
        sr = 24000
        wavs = [np.full(int(sr * 0.22), 0.12, dtype=np.float32) for _ in range(count)]
        return SynthesisResult(
            wavs=wavs,
            sample_rate=sr,
            model_id=model_id,
            device_used="cpu",
            dtype_used="float32",
            load_sec=0.0,
            gen_sec=0.01,
            audio_duration_sec=0.22 * count,
            rtf=0.05,
            peak_vram_mb=0.0,
            ram_mb=120.0,
        )

    def _wrapped(kind: str, model_id: str, texts: list[str], extra: str):
        with state["lock"]:
            state["active"] += 1
            state["max_concurrent"] = max(state["max_concurrent"], state["active"])
            call_num = len(state["calls"])
            state["calls"].append({"kind": kind, "model_id": model_id, "texts": list(texts), "extra": extra})
        try:
            time.sleep(state["delay_sec"])
            if state["fail_on_call_idx"] is not None and call_num >= state["fail_on_call_idx"]:
                raise RuntimeError(f"Simulated synthesis failure on chunk call #{call_num}")
            return _make_fake_res(model_id, len(texts))
        finally:
            with state["lock"]:
                state["active"] -= 1

    monkeypatch.setattr(
        type(tts_engine),
        "synthesize_voice_clone",
        lambda self, model_id, text, ref_audio, ref_text=None, language="English", **kw: _wrapped(
            "voice_clone", model_id, [text] if isinstance(text, str) else list(text), Path(str(ref_audio)).stem
        ),
    )
    monkeypatch.setattr(
        type(tts_engine),
        "synthesize_custom_voice",
        lambda self, model_id, text, speaker, language="English", instruct=None, **kw: _wrapped(
            "custom_voice", model_id, [text] if isinstance(text, str) else list(text), f"{speaker}|{instruct}"
        ),
    )
    monkeypatch.setattr(
        type(tts_engine),
        "synthesize_voice_design",
        lambda self, model_id, text, instruct, language="English", **kw: _wrapped(
            "voice_design", model_id, [text] if isinstance(text, str) else list(text), str(instruct)
        ),
    )

    return TestClient(app), state


def _wait_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/tts-studio/jobs/{job_id}").json()
        if j["status"] in ("completed", "partial", "cancelled", "failed"):
            return j
        time.sleep(0.03)
    raise AssertionError(f"Studio job {job_id} timed out")


def test_short_multiparagraph_long_text_voices_and_download(studio_env) -> None:
    client, state = studio_env

    # Honest engine capability disclosure
    caps = client.get("/api/tts-studio/config").json()
    assert caps["enabled"] is True
    assert caps["supports_generation_speed"] is False
    assert caps["supports_elevenlabs_sliders"] is False

    # 1. Short sentence
    r1 = client.post(
        "/api/tts-studio/generate",
        json={
            "text": "A single quiet lantern burned at the cliff edge.",
            "title": "Lantern Line",
            "voice_id": "narrator-deep-cinematic",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "instruct": "Speak very fast",  # Unsupported by 0.6B-Base -> safely ignored with warning
        },
    )
    assert r1.status_code == 200
    j1 = _wait_job(client, r1.json()["job_id"])
    assert j1["status"] == "completed"
    assert j1["total_chunks"] == 1
    assert "does not support style instructions" in (j1["warning"] or "")

    # Replay & download endpoints return valid WAV + attachment header
    assert client.get(j1["audio_url"]).status_code == 200
    dl = client.get(j1["download_url"])
    assert dl.status_code == 200
    assert "attachment" in dl.headers.get("content-disposition", "").lower()
    wav_data, sr = sf.read(io.BytesIO(dl.content))
    assert sr == 24000 and len(wav_data) > 2000

    # 2. Multi-paragraph + pause setting affects duration deterministically
    multi_text = "Paragraph one first sentence. Second sentence.\n\nParagraph two opening line.\n\nParagraph three closing line."
    r2a = client.post(
        "/api/tts-studio/generate",
        json={
            "text": multi_text,
            "voice_id": "narrator-warm-conversational",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "chunk_batch_size": 1,
            "pause_ms": 100,
        },
    ).json()
    j2a = _wait_job(client, r2a["job_id"])
    assert j2a["status"] == "completed"

    r2b = client.post(
        "/api/tts-studio/generate",
        json={
            "text": multi_text,
            "voice_id": "narrator-warm-conversational",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "chunk_batch_size": 1,
            "pause_ms": 500,
        },
    ).json()
    j2b = _wait_job(client, r2b["job_id"])
    assert j2b["status"] == "completed"
    assert j2b["duration_sec"] > j2a["duration_sec"] + 0.5  # Longer pause gap visibly lengthened output

    # 3. Long text sequential chunking & max_chunk_chars effect
    long_text = "\n\n".join(
        f"Paragraph {p} opens cleanly along the ridge. Shadows lengthen across the cold stone steps as thunder rumbles."
        for p in range(6)
    )
    plan_small = client.post("/api/tts-studio/plan", json={"text": long_text, "chunk_batch_size": 1, "max_chunk_chars": 160}).json()
    plan_batched = client.post("/api/tts-studio/plan", json={"text": long_text, "chunk_batch_size": 4, "max_chunk_chars": 380}).json()
    assert plan_small["paragraph_count"] == 6
    assert plan_small["chunk_count"] > plan_batched["chunk_count"]

    r_long = client.post(
        "/api/tts-studio/generate",
        json={
            "text": long_text,
            "voice_id": "narrator-deep-cinematic",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "chunk_batch_size": 1,
            "max_chunk_chars": 180,
        },
    ).json()
    j_long = _wait_job(client, r_long["job_id"])
    assert j_long["status"] == "completed"
    assert j_long["completed_chunks"] == j_long["total_chunks"] >= 6
    assert state["max_concurrent"] == 1

    # 4. Compatible voices switching & rejecting incompatible voice/model pair
    bad = client.post(
        "/api/tts-studio/generate",
        json={
            "text": "Hello",
            "voice_id": "preset-ryan",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        },
    )
    assert bad.status_code == 400

    # CustomVoice preset on 0.6B-CustomVoice works cleanly
    r_cv = client.post(
        "/api/tts-studio/generate",
        json={
            "text": "Testing Ryan preset voice cleanly.",
            "voice_id": "preset-ryan",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        },
    ).json()
    j_cv = _wait_job(client, r_cv["job_id"])
    assert j_cv["status"] == "completed"
    assert any(c["kind"] == "custom_voice" for c in state["calls"])

    # 5. History listing & delete cleanup (never leaves orphaned audio)
    hist = client.get("/api/tts-studio/history").json()["items"]
    assert len(hist) >= 5
    del_path = Path(j1["audio_path"])
    assert del_path.exists()
    assert client.delete(f"/api/tts-studio/items/{j1['job_id']}").status_code == 200
    assert not del_path.exists()


def test_voice_preview_cache_and_feature_flag(studio_env) -> None:
    client, state = studio_env

    # Instant built-in narrator preview without calling synth
    before_calls = len(state["calls"])
    pv1 = client.get("/api/tts-studio/voices/narrator-deep-cinematic/preview")
    assert pv1.status_code == 200
    assert len(state["calls"]) == before_calls

    # Preset voice initially lacks preview WAV -> POST generates via serialized queue, subsequent GET hits cache
    assert (
        client.get(
            "/api/tts-studio/voices/preset-ryan/preview",
            params={"model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"},
        ).status_code
        == 404
    )
    gen_pv = client.post(
        "/api/tts-studio/voices/preset-ryan/preview",
        json={"model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "device": "cpu"},
    )
    assert gen_pv.status_code == 200
    assert (
        client.get(
            "/api/tts-studio/voices/preset-ryan/preview",
            params={"model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"},
        ).status_code
        == 200
    )

    # Disabling feature flag disables all Studio routes cleanly without harming standard routes
    assert client.patch("/api/tts-studio/config", json={"enabled": False}).json()["enabled"] is False
    assert client.get("/api/tts-studio/voices").status_code == 403
    assert client.post("/api/tts-studio/generate", json={"text": "Hi", "voice_id": "narrator-deep-cinematic", "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"}).status_code == 403
    assert client.get("/api/voices").status_code == 200  # Core app untouched

    assert client.patch("/api/tts-studio/config", json={"enabled": True}).json()["enabled"] is True


def test_cancel_partial_preservation_failure_recovery_and_audiobook_isolation(studio_env) -> None:
    client, state = studio_env
    state["delay_sec"] = 0.08

    # 1. Cancel mid-run preserves completed chunks cleanly
    long_text = "\n\n".join(f"Sentence number {i} stands firmly by itself." for i in range(6))
    r_can = client.post(
        "/api/tts-studio/generate",
        json={
            "text": long_text,
            "voice_id": "narrator-deep-cinematic",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "chunk_batch_size": 1,
        },
    ).json()

    # Wait until at least 1 chunk finishes, then cancel
    for _ in range(50):
        cur = client.get(f"/api/tts-studio/jobs/{r_can['job_id']}").json()
        if cur["completed_chunks"] >= 1:
            break
        time.sleep(0.03)
    client.post(f"/api/tts-studio/jobs/{r_can['job_id']}/cancel")
    j_can = _wait_job(client, r_can["job_id"])
    assert j_can["status"] == "cancelled"
    assert 1 <= j_can["completed_chunks"] < j_can["total_chunks"]
    assert j_can["audio_available"] is True
    assert client.get(j_can["audio_url"]).status_code == 200

    # 2. Failure on later chunk preserves earlier completed chunks cleanly ('partial')
    state["delay_sec"] = 0.01
    state["fail_on_call_idx"] = len(state["calls"]) + 2
    r_fail = client.post(
        "/api/tts-studio/generate",
        json={
            "text": "One.\n\nTwo.\n\nThree.\n\nFour.",
            "voice_id": "narrator-deep-cinematic",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "chunk_batch_size": 1,
        },
    ).json()
    j_fail = _wait_job(client, r_fail["job_id"])
    assert j_fail["status"] == "partial"
    assert j_fail["completed_chunks"] == 2
    assert j_fail["audio_available"] is True
    assert "Simulated synthesis failure" in (j_fail["error_message"] or "")
    state["fail_on_call_idx"] = None

    # 3. GPU queue contention with active audiobook generation: serialized (max_concurrent == 1) & storage isolated
    book = client.post(
        "/api/books/import",
        files={"file": ("studio.epub", _make_sample_epub(), "application/epub+zip")},
    ).json()
    ch_id = book["chapters"][0]["chapter_id"]

    state["delay_sec"] = 0.08
    ab_res = client.post(
        "/api/audiobook/generate",
        json={
            "chapter_id": ch_id,
            "voice_id": "narrator-deep-cinematic",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "pregenerate_next": False,
        },
    )
    assert ab_res.status_code == 200

    st_res = client.post(
        "/api/tts-studio/generate",
        json={
            "text": "Queued cleanly behind active audiobook narration.",
            "voice_id": "narrator-warm-conversational",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        },
    ).json()
    # Immediately while audiobook holds worker, studio sees waiting_for_queue
    st_peek = client.get(f"/api/tts-studio/jobs/{st_res['job_id']}").json()
    if st_peek["status"] == "queued":
        assert st_peek["waiting_for_queue"] is True

    j_st = _wait_job(client, st_res["job_id"], timeout=15.0)
    assert j_st["status"] == "completed"
    assert state["max_concurrent"] == 1  # Strictly single-worker serialized GPU inference!

    # Wait for audiobook to finish and confirm audiobook cache & studio output are 100% separate
    for _ in range(80):
        ab_st = client.get(f"/api/audiobook/chapter/{ch_id}/status").json()
        if ab_st["complete"]:
            break
        time.sleep(0.04)
    assert ab_st["complete"] is True
    assert len(list(settings.audio_dir.rglob("*.wav"))) >= 1
    assert len(list((settings.storage_dir / "tts_studio" / "outputs").rglob("*.wav"))) >= 2

    with sqlite3.connect(str(settings.db_path)) as conn:
        ab_count = conn.execute("SELECT COUNT(*) FROM audio_chunks").fetchone()[0]
        st_count = conn.execute("SELECT COUNT(*) FROM tts_studio_jobs").fetchone()[0]
    assert ab_count >= 1
    assert st_count >= 3

