"""NovelFlow FastAPI application entrypoint (strictly bound to localhost)."""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse

from app.api.audiobook_routes import router as audiobook_router
from app.api.books_routes import router as books_router
from app.api.routes import router as core_router
from app.api.tts_studio_routes import router as tts_studio_router
from app.core.config import settings
from app.database.db import get_setting, init_database
from app.services.audiobook import audiobook_queue
from app.services.voices import seed_builtin_voices
from app.tts.engine import tts_engine


STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_database()
    seed_builtin_voices()
    audiobook_queue.start_worker()
    if "pytest" not in sys.modules and not os.environ.get("NOVELFLOW_DISABLE_PRELOAD"):
        tts_engine.preload_default_async(
            model_id=get_setting("active_model_id", settings.default_model_id),
            device=get_setting("device_preference", settings.default_device),
        )
    yield


app = FastAPI(
    title="NovelFlow Local AI Backend",
    version=settings.app_version,
    description="100% offline-first local EPUB & Qwen3-TTS audiobook engine.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8765",
        "http://localhost:8765",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "app://.",
        "null",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(core_router)
app.include_router(books_router)
app.include_router(audiobook_router)
app.include_router(tts_studio_router)


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/lab")


@app.get("/lab", include_in_schema=False)
def standalone_voice_lab():
    return FileResponse(STATIC_DIR / "voice_lab.html")

