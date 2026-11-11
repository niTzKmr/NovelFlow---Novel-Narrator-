"""Application configuration and local-only path management for NovelFlow."""

from __future__ import annotations

import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_root() -> Path:
    return Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    """Runtime settings keeping all models, storage, and server bindings strictly local."""

    app_name: str = "NovelFlow"
    app_version: str = "0.1.0"
    api_host: str = "127.0.0.1"
    api_port: int = 8765

    project_root: Path = _default_root()
    models_dir: Path | None = None
    storage_dir: Path | None = None
    books_dir: Path | None = None
    audio_dir: Path | None = None
    voices_dir: Path | None = None
    cache_dir: Path | None = None
    db_path: Path | None = None

    local_only_mode: bool = True
    telemetry_enabled: bool = False
    default_model_id: str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    default_device: str = "auto"

    model_config = SettingsConfigDict(env_prefix="NOVELFLOW_", extra="ignore")

    def model_post_init(self, __context: object) -> None:
        root = Path(self.project_root).resolve()
        if self.models_dir is None:
            self.models_dir = root / "models"
        if self.storage_dir is None:
            self.storage_dir = root / "storage"
        if self.books_dir is None:
            self.books_dir = self.storage_dir / "books"
        if self.audio_dir is None:
            self.audio_dir = self.storage_dir / "audio"
        if self.voices_dir is None:
            self.voices_dir = self.storage_dir / "voices"
        if self.cache_dir is None:
            self.cache_dir = self.storage_dir / "cache"
        if self.db_path is None:
            self.db_path = self.storage_dir / "db" / "novelflow.sqlite3"

        for p in (
            self.models_dir,
            self.storage_dir,
            self.books_dir,
            self.audio_dir,
            self.voices_dir,
            self.cache_dir,
            self.db_path.parent,
        ):
            p.mkdir(parents=True, exist_ok=True)

        # Keep Hugging Face operations local to D:\EPUBReader\models unless explicitly downloading
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        os.environ.setdefault("HF_HOME", str(self.models_dir / "hf_cache"))


settings = Settings()

