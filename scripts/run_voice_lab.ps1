$ErrorActionPreference = "Stop"
$env:PYTHONPATH = "D:\EPUBReader\backend"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
Write-Host "Starting NovelFlow Standalone Voice Testing Lab at http://127.0.0.1:8765/lab"
& "D:\EPUBReader\backend\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8765

