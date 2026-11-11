"""Generate the 3 original male narrator reference clips and audition fixed-script samples via the real TTS engine."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, r"D:\EPUBReader\backend")

from app.api.routes import FIXED_SAMPLE_SCRIPT, api_lab_generate
from app.database.db import init_database
from app.models.schemas import LabGenerateRequest
from app.services.hardware import detect_hardware
from app.services.voices import ORIGINAL_NARRATORS, ensure_narrator_reference_clip, seed_builtin_voices
from app.tts.engine import tts_engine


def main() -> None:
    init_database()
    seed_builtin_voices()

    hw = detect_hardware()
    print("=== Hardware ===")
    print(hw.model_dump_json(indent=2))

    # Step 1: Ensure each of the 3 original narrator profiles has a clean studio reference WAV
    # generated via 1.7B-VoiceDesign (CPU float32 so 4GB VRAM is never exceeded)
    for item in ORIGINAL_NARRATORS:
        vid = item["voice_id"]
        print(f"\n[1/2] Ensuring reference clip for {item['name']} ({vid})...", flush=True)
        ref_path = ensure_narrator_reference_clip(vid, device="cpu")
        print(f"      Reference WAV ready: {ref_path}", flush=True)

    # Release 1.7B-VoiceDesign CPU model before loading 0.6B-Base on RTX 3050 Ti GPU
    tts_engine.unload()

    # Step 2: Generate the fixed sample script for all 3 narrators on 0.6B-Base GPU (bfloat16)
    report = []
    for item in ORIGINAL_NARRATORS:
        vid = item["voice_id"]
        print(f"\n[2/2] Generating fixed-script sample for {item['name']} on 0.6B-Base (CUDA bfloat16)...", flush=True)
        res = api_lab_generate(
            LabGenerateRequest(
                voice_id=vid,
                model_id="Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                text=FIXED_SAMPLE_SCRIPT,
                device="auto",
            )
        )
        print(res.model_dump_json(indent=2), flush=True)
        report.append(res.model_dump())

    # Step 3: Generate one 0.6B-CustomVoice preset sample (Ryan) for baseline comparison
    print("\n[Bonus] Generating preset baseline 'Ryan' on 0.6B-CustomVoice (CUDA bfloat16)...", flush=True)
    ryan = api_lab_generate(
        LabGenerateRequest(
            voice_id="preset-ryan",
            model_id="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
            text=FIXED_SAMPLE_SCRIPT,
            device="auto",
        )
    )
    print(ryan.model_dump_json(indent=2), flush=True)
    report.append(ryan.model_dump())

    out_json = Path(r"D:\EPUBReader\storage\voices\narrator_lab_report.json")
    out_json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nSaved complete narrator sample report to {out_json}")


if __name__ == "__main__":
    main()

