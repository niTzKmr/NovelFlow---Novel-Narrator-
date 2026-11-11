"""Voice profile management: preset voices, original baritone narrators, Voice Design, and Voice Cloning."""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import soundfile as sf

from app.core.config import settings
from app.database.db import get_db, get_setting, set_setting
from app.models.schemas import DevicePreference, VoiceProfileOut
from app.tts.engine import tts_engine
from app.tts.registry import PRESET_SPEAKERS, get_model_spec


CALIBRATION_PASSAGE = (
    "In the quiet hours before dawn, the lantern beside the study window cast a steady amber glow "
    "across the weathered pages. He turned the parchment slowly, measuring every word with calm precision."
)

ORIGINAL_NARRATORS: list[dict[str, Any]] = [
    {
        "voice_id": "narrator-deep-cinematic",
        "name": "Deep Cinematic Narrator",
        "narrator_style": "deep_cinematic",
        "description": (
            "Primary NovelFlow male narrator: mature adult baritone with deep, rich resonance, "
            "natural American English accent, controlled vocal dynamics, realistic breathing, and poised pacing."
        ),
        "instruct_prompt": (
            "A mature adult male audiobook narrator with a deep, rich, warm baritone voice. "
            "Natural American English accent, clear articulation, realistic breathing and phrasing, "
            "controlled vocal dynamics, subtle emotional expression, conversational delivery, "
            "and smooth transitions between sentences. Clean dry close-microphone studio recording with no room echo. "
            "Avoid an artificial, excessively dramatic, monotone, or robotic sound."
        ),
    },
    {
        "voice_id": "narrator-warm-conversational",
        "name": "Warm Conversational Narrator",
        "narrator_style": "warm_conversational",
        "description": (
            "Approachable mature male storyteller with warm chest resonance, relaxed American cadence, "
            "intimate close-mic clarity, and effortless flow for long reading sessions."
        ),
        "instruct_prompt": (
            "A mature adult male audiobook storyteller in his early forties with a warm, reassuring baritone voice. "
            "Relaxed natural American English accent, intimate close-microphone studio recording, "
            "smooth unhurried phrasing, gentle warmth, realistic soft breaths, and natural conversational cadence. "
            "Avoid theatrical overacting or robotic stiffness."
        ),
    },
    {
        "voice_id": "narrator-expressive-audiobook",
        "name": "Expressive Audiobook Narrator",
        "narrator_style": "expressive_audiobook",
        "description": (
            "Seasoned male baritone voice actor with crisp diction, subtle dramatic tension, "
            "and dynamic narrative pacing suited for fantasy, cultivation, and suspense novels."
        ),
        "instruct_prompt": (
            "A seasoned adult male audiobook voice actor with a resonant low baritone register and crisp American English diction. "
            "Expressive storytelling with subtle emotional modulation, grounded gravitas during tense lines, "
            "natural pauses between clauses, and clean studio voice clarity without background noise."
        ),
    },
]


def _refs_dir() -> Path:
    d = settings.voices_dir / "refs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prompts_dir() -> Path:
    d = settings.voices_dir / "prompts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _row_to_out(row: Any) -> VoiceProfileOut:
    vid = row["voice_id"]
    sample_path = row["sample_audio_path"]
    sample_url = f"/api/voices/{vid}/sample" if sample_path and Path(sample_path).exists() else None
    return VoiceProfileOut(
        voice_id=vid,
        name=row["name"],
        kind=row["kind"],
        description=row["description"],
        narrator_style=row["narrator_style"],
        instruct_prompt=row["instruct_prompt"],
        speaker_name=row["speaker_name"],
        ref_audio_path=row["ref_audio_path"],
        ref_text=row["ref_text"],
        prompt_cache_path=row["prompt_cache_path"],
        sample_audio_url=sample_url,
        compatible_models=json.loads(row["compatible_models_json"]),
        is_builtin=bool(row["is_builtin"]),
        is_preferred=bool(row["is_preferred"]),
        consent_confirmed=bool(row["consent_confirmed"]),
        created_at=row["created_at"],
    )


def seed_builtin_voices() -> None:
    """Ensure the 3 original male narrator profiles and preset speakers exist in SQLite."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    preferred_id = get_setting("preferred_voice_id", "narrator-deep-cinematic")

    with get_db() as conn:
        for item in ORIGINAL_NARRATORS:
            vid = item["voice_id"]
            ref_wav = _refs_dir() / f"{vid}.wav"
            prompt_pt = _prompts_dir() / f"{vid}.pt"
            compat_models = [
                "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
                "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            ]
            conn.execute(
                """
                INSERT INTO voice_profiles (
                    voice_id, name, kind, description, narrator_style, instruct_prompt,
                    speaker_name, ref_audio_path, ref_text, prompt_cache_path, sample_audio_path,
                    compatible_models_json, is_builtin, is_preferred, consent_confirmed, created_at
                ) VALUES (?, ?, 'designed_narrator', ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, 1, ?)
                ON CONFLICT(voice_id) DO UPDATE SET
                    name=excluded.name,
                    description=excluded.description,
                    instruct_prompt=excluded.instruct_prompt,
                    compatible_models_json=excluded.compatible_models_json
                """,
                (
                    vid,
                    item["name"],
                    item["description"],
                    item["narrator_style"],
                    item["instruct_prompt"],
                    str(ref_wav),
                    CALIBRATION_PASSAGE,
                    str(prompt_pt),
                    str(ref_wav) if ref_wav.exists() else None,
                    json.dumps(compat_models),
                    1 if vid == preferred_id else 0,
                    now,
                ),
            )

        for spk in PRESET_SPEAKERS:
            vid = f"preset-{spk['speaker'].lower()}"
            compat_models = [
                "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
            ]
            conn.execute(
                """
                INSERT INTO voice_profiles (
                    voice_id, name, kind, description, narrator_style, instruct_prompt,
                    speaker_name, ref_audio_path, ref_text, prompt_cache_path, sample_audio_path,
                    compatible_models_json, is_builtin, is_preferred, consent_confirmed, created_at
                ) VALUES (?, ?, 'preset', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, 1, ?, 1, ?)
                ON CONFLICT(voice_id) DO UPDATE SET
                    name=excluded.name,
                    description=excluded.description,
                    speaker_name=excluded.speaker_name,
                    compatible_models_json=excluded.compatible_models_json
                """,
                (
                    vid,
                    spk["name"],
                    f"{spk['description']} (Native: {spk['native_language']})",
                    spk["native_language"].lower(),
                    spk["speaker"],
                    json.dumps(compat_models),
                    1 if vid == preferred_id else 0,
                    now,
                ),
            )


def list_voices(model_id: Optional[str] = None) -> list[VoiceProfileOut]:
    seed_builtin_voices()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM voice_profiles ORDER BY is_preferred DESC, CASE kind WHEN 'designed_narrator' THEN 0 WHEN 'cloned' THEN 1 ELSE 2 END, created_at ASC"
        ).fetchall()
    voices = [_row_to_out(r) for r in rows]
    if model_id:
        voices = [v for v in voices if model_id in v.compatible_models]
    return voices


def get_voice(voice_id: str) -> VoiceProfileOut:
    seed_builtin_voices()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE voice_id = ?", (voice_id,)).fetchone()
    if not row:
        raise KeyError(f"Voice profile '{voice_id}' not found.")
    return _row_to_out(row)


def ensure_narrator_reference_clip(voice_id: str, device: DevicePreference = "auto") -> Path:
    """Ensure a designed narrator profile has a clean local studio reference WAV on disk."""
    voice = get_voice(voice_id)
    if not voice.ref_audio_path:
        raise ValueError(f"Voice '{voice_id}' has no reference audio target.")
    ref_path = Path(voice.ref_audio_path)
    if ref_path.exists() and ref_path.stat().st_size > 1000:
        return ref_path

    if not voice.instruct_prompt:
        raise ValueError(f"Voice '{voice_id}' lacks an instruct_prompt to synthesize its reference clip.")

    design_model = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    spec = get_model_spec(design_model)
    if not spec.is_downloaded():
        raise FileNotFoundError(
            f"Reference clip for '{voice.name}' does not exist yet and {design_model} is not downloaded."
        )

    res = tts_engine.synthesize_voice_design(
        model_id=design_model,
        text=voice.ref_text or CALIBRATION_PASSAGE,
        instruct=voice.instruct_prompt,
        language="English",
        device=device,
    )
    ref_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(ref_path), res.wavs[0], res.sample_rate)

    with get_db() as conn:
        conn.execute(
            "UPDATE voice_profiles SET sample_audio_path = ? WHERE voice_id = ?",
            (str(ref_path), voice_id),
        )
    return ref_path


def create_designed_voice_profile(
    name: str,
    description: str,
    instruct: str,
    reference_text: Optional[str] = None,
    device: DevicePreference = "auto",
) -> tuple[VoiceProfileOut, dict[str, Any]]:
    """Synthesize an original voice via 1.7B-VoiceDesign and save it as a reusable profile."""
    ref_txt = (reference_text or CALIBRATION_PASSAGE).strip()
    design_model = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    res = tts_engine.synthesize_voice_design(
        model_id=design_model,
        text=ref_txt,
        instruct=instruct,
        language="English",
        device=device,
    )

    vid = f"design-{uuid.uuid4().hex[:10]}"
    ref_wav = _refs_dir() / f"{vid}.wav"
    prompt_pt = _prompts_dir() / f"{vid}.pt"
    sf.write(str(ref_wav), res.wavs[0], res.sample_rate)

    compat_models = [
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    ]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO voice_profiles (
                voice_id, name, kind, description, narrator_style, instruct_prompt,
                speaker_name, ref_audio_path, ref_text, prompt_cache_path, sample_audio_path,
                compatible_models_json, is_builtin, is_preferred, consent_confirmed, created_at
            ) VALUES (?, ?, 'designed_narrator', ?, 'custom_design', ?, NULL, ?, ?, ?, ?, ?, 0, 0, 1, ?)
            """,
            (
                vid,
                name.strip(),
                description.strip(),
                instruct.strip(),
                str(ref_wav),
                ref_txt,
                str(prompt_pt),
                str(ref_wav),
                json.dumps(compat_models),
                now,
            ),
        )
    metrics = {
        "generation_sec": res.gen_sec,
        "audio_duration_sec": res.audio_duration_sec,
        "rtf": res.rtf,
        "device_used": res.device_used,
        "dtype_used": res.dtype_used,
    }
    return get_voice(vid), metrics


def create_cloned_voice_profile(
    name: str,
    description: str,
    ref_text: str,
    audio_bytes: bytes,
    filename: str,
    consent_confirmed: bool,
) -> VoiceProfileOut:
    """Save an authorized local reference audio sample as a reusable Voice Clone profile."""
    if not consent_confirmed:
        raise ValueError(
            "Explicit permission & rights confirmation is required before storing a voice cloning reference."
        )

    ext = Path(filename).suffix.lower() or ".wav"
    if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
        raise ValueError(f"Unsupported reference audio format: {ext}")

    vid = f"clone-{uuid.uuid4().hex[:10]}"
    raw_path = _refs_dir() / f"{vid}_raw{ext}"
    wav_path = _refs_dir() / f"{vid}.wav"
    prompt_pt = _prompts_dir() / f"{vid}.pt"
    raw_path.write_bytes(audio_bytes)

    try:
        import librosa
        audio, sr = librosa.load(str(raw_path), sr=24000, mono=True)
        if len(audio) / 24000 < 2.0:
            raise ValueError("Reference recording must be at least 2 seconds of clear speech.")
        sf.write(str(wav_path), audio, 24000)
    finally:
        if raw_path.exists() and raw_path != wav_path:
            raw_path.unlink(missing_ok=True)

    compat_models = [
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    ]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO voice_profiles (
                voice_id, name, kind, description, narrator_style, instruct_prompt,
                speaker_name, ref_audio_path, ref_text, prompt_cache_path, sample_audio_path,
                compatible_models_json, is_builtin, is_preferred, consent_confirmed, created_at
            ) VALUES (?, ?, 'cloned', ?, 'cloned', NULL, NULL, ?, ?, ?, ?, ?, 0, 0, 1, ?)
            """,
            (
                vid,
                name.strip(),
                description.strip(),
                str(wav_path),
                ref_text.strip(),
                str(prompt_pt),
                str(wav_path),
                json.dumps(compat_models),
                now,
            ),
        )
    return get_voice(vid)


def set_preferred_voice(voice_id: str) -> VoiceProfileOut:
    _ = get_voice(voice_id)
    with get_db() as conn:
        conn.execute("UPDATE voice_profiles SET is_preferred = 0")
        conn.execute("UPDATE voice_profiles SET is_preferred = 1 WHERE voice_id = ?", (voice_id,))
    set_setting("preferred_voice_id", voice_id)
    return get_voice(voice_id)


def delete_voice(voice_id: str) -> dict[str, Any]:
    voice = get_voice(voice_id)
    if voice.is_builtin:
        raise ValueError("Built-in system voices cannot be deleted; delete custom saved or cloned profiles instead.")

    with get_db() as conn:
        conn.execute("DELETE FROM voice_profiles WHERE voice_id = ?", (voice_id,))
        if voice.is_preferred:
            conn.execute("UPDATE voice_profiles SET is_preferred = 1 WHERE voice_id = 'narrator-deep-cinematic'")
    if voice.is_preferred:
        set_setting("preferred_voice_id", "narrator-deep-cinematic")

    for p_str in (voice.ref_audio_path, voice.prompt_cache_path):
        if p_str:
            p = Path(p_str)
            if p.exists():
                p.unlink(missing_ok=True)

    return {"deleted": True, "voice_id": voice_id}
