"""Tests for Phase 2 Voice Testing Lab, hardware compatibility, capability gating, and profile lifecycle."""

from __future__ import annotations

import io
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.database.db import init_database
from app.main import app
from app.services.voices import seed_builtin_voices


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    db_file = tmp_path / "test.sqlite3"
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "db_path", db_file)
    monkeypatch.setattr(settings, "voices_dir", voices_dir)
    init_database(db_file)
    seed_builtin_voices()
    return TestClient(app)


def _make_wav_bytes(seconds: float = 2.5, sr: int = 24000) -> bytes:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    samples = (0.2 * np.sin(2 * np.pi * 220 * t) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


def test_health_and_hardware(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["local_only"] is True
    assert r.json()["telemetry_enabled"] is False

    hw = client.get("/api/system/hardware")
    assert hw.status_code == 200
    data = hw.json()
    assert data["ram_total_gb"] > 0
    assert data["disk_free_gb"] > 0


def test_models_capability_matrix_never_conflates_features(client: TestClient) -> None:
    r = client.get("/api/models")
    assert r.status_code == 200
    models = {m["model_id"]: m for m in r.json()}

    assert models["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"]["supports_preset_speakers"] is True
    assert models["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"]["supports_instruct"] is False
    assert models["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"]["supports_instruct"] is True
    assert models["Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"]["supports_voice_design"] is True
    assert models["Qwen/Qwen3-TTS-12Hz-0.6B-Base"]["supports_voice_clone"] is True

    # On <= 4 GB VRAM hardware, 1.7B models must warn and recommend CPU fallback
    hw = client.get("/api/system/hardware").json()
    if hw["cuda_available"] and hw["vram_total_gb"] < 5.0:
        compat_17b = models["Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"]["compatibility"]
        assert compat_17b["fits_dedicated_vram"] is False
        assert compat_17b["recommended_device"] == "cpu"


def test_builtin_three_narrators_and_voice_lab_ui(client: TestClient) -> None:
    r = client.get("/api/voices")
    assert r.status_code == 200
    voices = {v["voice_id"]: v for v in r.json()}
    assert "narrator-deep-cinematic" in voices
    assert "narrator-warm-conversational" in voices
    assert "narrator-expressive-audiobook" in voices

    lab_html = client.get("/lab")
    assert lab_html.status_code == 200
    assert "Beyond the mountains" in open(r"D:\EPUBReader\backend\app\api\routes.py", encoding="utf-8").read()
    assert "NovelFlow" in lab_html.text


def test_voice_clone_requires_consent_and_supports_delete(client: TestClient) -> None:
    wav_bytes = _make_wav_bytes(2.6)
    denied = client.post(
        "/api/voices/clone",
        data={
            "name": "Unauthorized Test",
            "ref_text": "Testing unauthorized voice cloning rejection.",
            "consent_confirmed": "false",
        },
        files={"audio_file": ("ref.wav", wav_bytes, "audio/wav")},
    )
    assert denied.status_code == 400
    assert "permission" in denied.json()["detail"].lower()

    allowed = client.post(
        "/api/voices/clone",
        data={
            "name": "Authorized Studio Voice",
            "ref_text": "Testing authorized voice cloning storage.",
            "consent_confirmed": "true",
        },
        files={"audio_file": ("ref.wav", wav_bytes, "audio/wav")},
    )
    assert allowed.status_code == 200
    vid = allowed.json()["voice_id"]

    # Prefer & delete
    pref = client.post(f"/api/voices/{vid}/prefer")
    assert pref.status_code == 200
    assert pref.json()["is_preferred"] is True

    deleted = client.delete(f"/api/voices/{vid}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True


def test_incompatible_checkpoint_and_voice_rejected(client: TestClient) -> None:
    r = client.post(
        "/api/tts/lab/generate",
        json={
            "voice_id": "preset-ryan",
            "model_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "text": "Hello world.",
        },
    )
    assert r.status_code == 400
    assert "not compatible" in r.json()["detail"].lower()

