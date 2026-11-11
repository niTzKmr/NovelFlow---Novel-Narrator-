import {
  AlertCircle,
  AudioLines,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  History,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveBackendUrl } from "../../services/api";
import { ttsStudioApi, type StudioPlanStats } from "../../services/ttsStudioApi";
import { useAppStore } from "../../store/useAppStore";
import { useTtsStudioStore } from "../../store/useTtsStudioStore";

const SAMPLE_SHORT = "Beyond the storm, a lone lantern flickered along the obsidian cliffside.";
const SAMPLE_MULTI_PARA = `In the quiet hours before dawn, the lantern beside the study window cast a steady amber glow across the weathered parchment scrolls.

"Have the elders arrived yet?" Lin asked, keeping his voice low as wind rattled the timber shutters.

Outside, the mountain courtyard remained silent, save for the steady cadence of falling rain against ancient stone.`;

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function TtsStudioPage() {
  const { models, hardware, settings, setPage } = useAppStore();
  const {
    initialized,
    enabled,
    capabilities,
    voices,
    selectedModelId,
    selectedVoiceId,
    title,
    text,
    language,
    instruct,
    device,
    outputFormat,
    chunkBatchSize,
    maxChunkChars,
    pauseMs,
    playbackSpeed,
    volume,
    activeJob,
    isGenerating,
    errorMsg,
    statusMsg,
    history,
    previewingVoiceId,
    playingItem,
    isPlaying,
    currentTimeSec,
    durationSec,
    initStudio,
    setField,
    refreshVoices,
    previewVoice,
    startGeneration,
    cancelGeneration,
    playHistoryItem,
    togglePlayPause,
    replayAudio,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    deleteHistoryItem,
    loadItemIntoEditor,
  } = useTtsStudioStore();

  const [settingsOpen, setSettingsOpen] = useState(true);
  const [planStats, setPlanStats] = useState<StudioPlanStats | null>(null);

  useEffect(() => {
    if (!initialized && settings) {
      void initStudio(settings.active_model_id, settings.preferred_voice_id, settings.device_preference);
    }
  }, [initialized, settings, initStudio]);

  useEffect(() => {
    if (!enabled) return;
    if (!text.trim()) {
      setPlanStats(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void ttsStudioApi
        .getPlan({ text, chunk_batch_size: chunkBatchSize, max_chunk_chars: maxChunkChars })
        .then(setPlanStats)
        .catch(() => {});
    }, 220);
    return () => window.clearTimeout(timer);
  }, [enabled, text, chunkBatchSize, maxChunkChars]);

  const localCounts = useMemo(() => {
    const trimmed = text.trim();
    const chars = text.length;
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const paragraphs = trimmed ? trimmed.split(/\n+/).filter((p) => p.trim()).length : 0;
    return { chars, words, paragraphs };
  }, [text]);

  const selectedModel = useMemo(
    () => models.find((m) => m.model_id === selectedModelId) || models[0],
    [models, selectedModelId]
  );

  const selectedVoice = useMemo(
    () => voices.find((v) => v.voice_id === selectedVoiceId) || null,
    [voices, selectedVoiceId]
  );

  const ffmpegReady = Boolean(capabilities?.ffmpeg_available);

  if (!enabled) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-7 space-y-3 text-center">
          <AudioLines className="w-8 h-8 text-[#d4a373] mx-auto" />
          <h1 className="text-lg font-semibold text-[#f4f4f7]">Text-to-Speech Studio is Disabled</h1>
          <p className="text-xs text-[#8e8e9c] max-w-md mx-auto">
            Enable the Text-to-Speech Studio feature flag in Settings whenever you want to synthesize standalone text offline.
          </p>
          <button
            onClick={() => setPage("settings")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  const pct =
    activeJob && activeJob.total_chunks > 0
      ? Math.round((activeJob.completed_chunks / activeJob.total_chunks) * 100)
      : 0;

  return (
    <div className="p-7 max-w-7xl mx-auto space-y-6 pb-16">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-[#f4f4f7]">Text to Speech Studio</h1>
            <span className="px-2 py-0.5 rounded-md text-[10.5px] font-medium bg-[#d4a373]/15 text-[#d4a373] border border-[#d4a373]/30">
              Offline Qwen3-TTS
            </span>
          </div>
          <p className="text-sm text-[#8e8e9c] mt-0.5">
            Standalone voice synthesis studio isolated from your EPUB library and audiobook narration queue.
          </p>
        </div>

        <div className="px-3.5 py-2 rounded-xl bg-[#16161b] border border-[#262630] text-xs text-[#9c9caa]">
          {hardware?.cuda_available
            ? `GPU: ${hardware.gpu_name} (${hardware.vram_total_gb} GB VRAM)`
            : `CPU: ${hardware?.cpu_name || "Detecting..."}`}
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl bg-[#221719] border border-red-500/40 px-4 py-3 text-xs text-red-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setField("errorMsg", null)} className="text-red-300 hover:text-white underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Editor, Progress & Player */}
        <div className="lg:col-span-7 space-y-5">
          {/* Script Editor Card */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                type="text"
                value={title}
                onChange={(e) => setField("title", e.target.value)}
                placeholder="Optional clip title (auto-generated from text if left blank)"
                className="flex-1 min-w-[220px] bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3.5 py-2 text-xs text-[#f2f2f6] placeholder-[#6d6d7c] outline-none focus:border-[#d4a373]"
              />
              <div className="flex items-center gap-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setField("text", SAMPLE_SHORT)}
                  className="px-2.5 py-1.5 rounded-lg bg-[#1e1e26] border border-[#2c2c38] text-[#b4b4c4] hover:text-white"
                >
                  Short Sample
                </button>
                <button
                  type="button"
                  onClick={() => setField("text", SAMPLE_MULTI_PARA)}
                  className="px-2.5 py-1.5 rounded-lg bg-[#1e1e26] border border-[#2c2c38] text-[#b4b4c4] hover:text-white"
                >
                  Multi-Paragraph
                </button>
                <button
                  type="button"
                  disabled={!text}
                  onClick={() => {
                    setField("text", "");
                    setField("title", "");
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-[#23191d] border border-[#3a262c] text-red-200 hover:bg-red-500/20 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>

            <textarea
              value={text}
              onChange={(e) => setField("text", e.target.value)}
              placeholder="Type or paste any text, dialogue, narration, or long-form script here. Paragraph breaks are preserved and long text is synthesized sequentially across chunks..."
              rows={11}
              className="w-full min-h-[250px] bg-[#121217] border border-[#282834] rounded-xl p-4 text-[14.5px] leading-relaxed font-serif text-[#f3f3f6] placeholder-[#646474] outline-none focus:border-[#d4a373] resize-y"
            />

            {/* Live Counts & Estimate Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-[11.5px] text-[#8d8d9c]">
              <div className="flex flex-wrap items-center gap-3 tabular-nums">
                <span>{localCounts.chars.toLocaleString()} characters</span>
                <span>•</span>
                <span>{localCounts.words.toLocaleString()} words</span>
                <span>•</span>
                <span>{localCounts.paragraphs} paragraph(s)</span>
                {planStats && (
                  <>
                    <span>•</span>
                    <span className="text-[#d4a373]">
                      {planStats.chunk_count} sequential chunk{planStats.chunk_count === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                {selectedVoice && (
                  <span className="text-[#c5c5d4]">
                    Voice: <strong className="text-[#f3f3f7]">{selectedVoice.name}</strong>
                  </span>
                )}
                {isGenerating ? (
                  <button
                    onClick={() => void cancelGeneration()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-200 text-xs font-semibold hover:bg-red-500/30"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    Cancel Generation
                  </button>
                ) : (
                  <button
                    onClick={() => void startGeneration()}
                    disabled={!text.trim() || !selectedVoiceId}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105 disabled:opacity-45"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Generate Speech
                  </button>
                )}
              </div>
            </div>

            {/* Active Generation / Queue Contention Progress */}
            {(isGenerating || statusMsg) && (
              <div className="rounded-xl bg-[#1a1a22] border border-[#282834] p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[#e6e6ee]">
                    {isGenerating && <Loader2 className="w-3.5 h-3.5 text-[#d4a373] animate-spin shrink-0" />}
                    <span>{statusMsg || "Ready"}</span>
                  </div>
                  {activeJob && activeJob.total_chunks > 0 && (
                    <span className="text-[#9e9eae] tabular-nums">
                      {activeJob.completed_chunks}/{activeJob.total_chunks} chunks ({pct}%)
                    </span>
                  )}
                </div>

                {activeJob && activeJob.total_chunks > 0 && (
                  <div className="h-1.5 w-full rounded-full bg-[#262632] overflow-hidden">
                    <div
                      className="h-full bg-[#d4a373] transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                {activeJob?.waiting_for_queue && (
                  <div className="text-[11px] text-amber-300">
                    GPU queue busy ({activeJob.queue_active_task || "active synthesis"}). Studio job will start automatically once the active task yields—active audiobook playback will not be interrupted.
                  </div>
                )}

                {activeJob?.current_chunk_text && isGenerating && (
                  <div className="text-[11px] text-[#858594] truncate">
                    Synthesizing: “{activeJob.current_chunk_text}”
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Dedicated Studio Audio Player */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wider text-[#888896] font-medium">Generated Audio Output</div>
                <div className="text-sm font-semibold text-[#f3f3f7] truncate mt-0.5">
                  {playingItem ? playingItem.title : "No track loaded yet"}
                </div>
                {playingItem && (
                  <div className="text-[11.5px] text-[#9494a4] truncate">
                    {playingItem.voice_name} • {playingItem.model_id.split("/").pop()} •{" "}
                    {(playingItem.audio_format || "wav").toUpperCase()}
                    {playingItem.status === "partial" || playingItem.status === "cancelled"
                      ? ` • Partial (${playingItem.completed_chunks}/${playingItem.total_chunks} chunks)`
                      : ""}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                {playingItem && (
                  <button
                    disabled={isGenerating}
                    onClick={() => {
                      loadItemIntoEditor(playingItem);
                      void startGeneration();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#20202a] border border-[#2e2e3c] text-xs text-[#dcdce6] hover:border-[#d4a373]/50 disabled:opacity-40"
                    title="Regenerate this text using the currently selected voice"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#d4a373]" />
                    Regenerate
                  </button>
                )}

                {playingItem?.download_url && (
                  <a
                    href={resolveBackendUrl(playingItem.download_url)}
                    download
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download {(playingItem.audio_format || "WAV").toUpperCase()}
                  </a>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                disabled={!playingItem}
                onClick={() => void togglePlayPause()}
                className="w-10 h-10 rounded-full bg-[#d4a373] text-[#141210] flex items-center justify-center hover:brightness-105 disabled:opacity-35 shrink-0"
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </button>

              <button
                disabled={!playingItem}
                onClick={() => void replayAudio()}
                className="p-2 rounded-xl bg-[#1e1e26] border border-[#2b2b38] text-[#b4b4c4] hover:text-white disabled:opacity-35"
                title="Replay from beginning"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <div className="flex-1 flex items-center gap-2.5 text-xs tabular-nums text-[#8e8e9d]">
                <span className="w-10 text-right">{fmtTime(currentTimeSec)}</span>
                <input
                  type="range"
                  disabled={!playingItem}
                  min={0}
                  max={Math.max(0.1, durationSec || playingItem?.duration_sec || 0)}
                  step={0.05}
                  value={Math.min(currentTimeSec, durationSec || playingItem?.duration_sec || 0)}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  className="flex-1 accent-[#d4a373]"
                />
                <span className="w-10">{fmtTime(durationSec || playingItem?.duration_sec || 0)}</span>
              </div>

              <div className="hidden sm:flex items-center gap-1.5 text-xs text-[#9b9ba8]">
                <Volume2 className="w-3.5 h-3.5" />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="w-16 accent-[#d4a373]"
                />
              </div>

              <select
                value={playbackSpeed}
                onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                className="bg-[#1e1e26] border border-[#2c2c38] rounded-lg px-2 py-1 text-xs text-white"
                title="Player speed (real-time playback only)"
              >
                {[0.75, 1, 1.25, 1.5, 1.75, 2].map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}x
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Voice Selection, Supported Voice Settings & History */}
        <div className="lg:col-span-5 space-y-5">
          {/* Voice Selection Card */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-[#f1f1f4]">Voice & Checkpoint</div>
              <span className="text-[11px] text-[#8d8d9b]">{voices.length} compatible</span>
            </div>

            <div>
              <label className="block text-[11.5px] text-[#8d8d9b] mb-1">Active Qwen3-TTS Checkpoint</label>
              <select
                value={selectedModelId}
                onChange={(e) => {
                  const mid = e.target.value;
                  setField("selectedModelId", mid);
                  void refreshVoices(mid);
                }}
                className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#d4a373]"
              >
                {models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.display_name} {m.is_downloaded ? "✓ Local" : "(Not Downloaded)"}
                  </option>
                ))}
              </select>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
              {voices.map((v) => {
                const selected = v.voice_id === selectedVoiceId;
                const previewActive = previewingVoiceId === v.voice_id;
                return (
                  <div
                    key={v.voice_id}
                    onClick={() => setField("selectedVoiceId", v.voice_id)}
                    className={`rounded-xl border p-3 cursor-pointer transition-colors ${
                      selected
                        ? "bg-[#221e19] border-[#d4a373]/70"
                        : "bg-[#1a1a21] border-[#262632] hover:border-[#3b3b4a]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-2">
                        <span className="text-xs font-semibold text-[#f3f3f7] truncate">{v.name}</span>
                        <span className="px-1.5 py-0.5 rounded bg-[#252532] text-[10px] text-[#b4b4c4] shrink-0">
                          {v.kind === "designed_narrator" ? "Narrator" : v.kind}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void previewVoice(v.voice_id);
                        }}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] shrink-0 ${
                          previewActive
                            ? "bg-[#d4a373] text-[#141210] font-semibold"
                            : "bg-[#242430] text-[#dcdce6] hover:bg-[#303040]"
                        }`}
                      >
                        {previewActive ? <Square className="w-3 h-3 fill-current" /> : <Volume2 className="w-3 h-3" />}
                        {previewActive ? "Stop" : "Preview"}
                      </button>
                    </div>
                    <p className="text-[11px] text-[#8d8d9c] mt-1 line-clamp-2">{v.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Collapsible Voice Settings */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] overflow-hidden">
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              className="w-full px-5 py-3.5 flex items-center justify-between text-sm font-semibold text-[#f1f1f4] hover:bg-[#1a1a21]"
            >
              <span className="inline-flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-[#d4a373]" />
                Voice & Export Settings
              </span>
              {settingsOpen ? <ChevronUp className="w-4 h-4 text-[#8d8d9b]" /> : <ChevronDown className="w-4 h-4 text-[#8d8d9b]" />}
            </button>

            {settingsOpen && (
              <div className="px-5 pb-5 pt-2 border-t border-[#242430] space-y-3.5 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[#8d8d9b] mb-1">Language</label>
                    <select
                      value={language}
                      onChange={(e) => setField("language", e.target.value as "English" | "Auto")}
                      className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
                    >
                      <option value="English">English</option>
                      <option value="Auto">Auto Multilingual</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[#8d8d9b] mb-1">Compute Device</label>
                    <select
                      value={device}
                      onChange={(e) => setField("device", e.target.value as "auto" | "cuda" | "cpu")}
                      className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
                    >
                      <option value="auto">Auto (VRAM Safe)</option>
                      <option value="cuda">CUDA GPU</option>
                      <option value="cpu">CPU Fallback</option>
                    </select>
                  </div>
                </div>

                {/* Output Format */}
                <div>
                  <label className="block text-[#8d8d9b] mb-1">
                    Output Audio Format {!ffmpegReady && "(FFmpeg not detected — WAV only)"}
                  </label>
                  <select
                    value={outputFormat}
                    onChange={(e) => setField("outputFormat", e.target.value as "wav" | "mp3" | "aac")}
                    className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
                  >
                    <option value="wav">Lossless WAV (Native Qwen3-TTS)</option>
                    <option value="mp3" disabled={!ffmpegReady}>
                      Compressed MP3 128k {!ffmpegReady ? "(Requires FFmpeg)" : "(FFmpeg)"}
                    </option>
                    <option value="aac" disabled={!ffmpegReady}>
                      Compressed AAC 128k {!ffmpegReady ? "(Requires FFmpeg)" : "(FFmpeg)"}
                    </option>
                  </select>
                </div>

                {/* Segmentation & Pause */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[#8d8d9b] mb-1">Chunk Batch Size</label>
                    <select
                      value={chunkBatchSize}
                      onChange={(e) => setField("chunkBatchSize", Number(e.target.value))}
                      className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
                    >
                      <option value={1}>1 sentence (4 GB Safe)</option>
                      <option value={2}>2 sentences</option>
                      <option value={3}>3 sentences</option>
                      <option value={4}>4 sentences</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[#8d8d9b] mb-1">Sentence Pause ({pauseMs} ms)</label>
                    <input
                      type="range"
                      min={80}
                      max={800}
                      step={20}
                      value={pauseMs}
                      onChange={(e) => setField("pauseMs", Number(e.target.value))}
                      className="w-full accent-[#d4a373] mt-2"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-[#8d8d9b] mb-1">
                    <span>Max Characters per Chunk</span>
                    <span className="tabular-nums">{maxChunkChars} chars</span>
                  </div>
                  <input
                    type="range"
                    min={160}
                    max={420}
                    step={20}
                    value={maxChunkChars}
                    onChange={(e) => setField("maxChunkChars", Number(e.target.value))}
                    className="w-full accent-[#d4a373]"
                  />
                </div>

                {/* Speaking Speed (explicitly labeled player-only) */}
                <div className="rounded-xl bg-[#1a1a22] border border-[#282834] p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#e4e4ee]">Speaking Speed ({playbackSpeed.toFixed(2)}x)</span>
                    <span className="px-1.5 py-0.5 rounded bg-[#d4a373]/15 text-[#d4a373] text-[10px]">
                      Player Only
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.75}
                    max={2.0}
                    step={0.05}
                    value={playbackSpeed}
                    onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                    className="w-full accent-[#d4a373]"
                  />
                  <div className="text-[10.5px] text-[#848494]">
                    Adjusts real-time player speed only. Qwen3-TTS does not support generation-time speed scaling, stability, similarity, style exaggeration, or speaker boost sliders.
                  </div>
                </div>

                {/* Instruct support */}
                {selectedModel?.supports_instruct ? (
                  <div>
                    <label className="block text-[#8d8d9b] mb-1">
                      Style Instruction (Supported by {selectedModel.short_name})
                    </label>
                    <textarea
                      rows={2}
                      value={instruct}
                      onChange={(e) => setField("instruct", e.target.value)}
                      placeholder="Optional tone/style instruction (e.g. calm, low baritone, unhurried pace)"
                      className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#d4a373]"
                    />
                  </div>
                ) : (
                  <div className="text-[10.5px] text-[#7c7c8c] bg-[#1a1a22] border border-[#262632] rounded-xl px-3 py-2">
                    Active model <span className="text-[#c5c5d4]">{selectedModel?.short_name}</span> uses voice reference acoustics only and does not support natural-language `instruct` prompts.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Generation History Card */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
                <History className="w-4 h-4 text-[#d4a373]" />
                <span>Studio History</span>
              </div>
              <span className="text-[11px] text-[#8d8d9b]">{history.length} saved</span>
            </div>

            {history.length === 0 ? (
              <div className="text-xs text-[#7e7e8c] py-3">
                Generated clips appear here with local replay, text reload, and audio export.
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                {history.map((item) => {
                  const active = playingItem?.job_id === item.job_id;
                  return (
                    <div
                      key={item.job_id}
                      className={`rounded-xl border p-3 space-y-2 text-xs ${
                        active ? "bg-[#221e19] border-[#d4a373]/60" : "bg-[#1a1a21] border-[#262632]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-[#f1f1f5] truncate">{item.title}</div>
                          <div className="text-[11px] text-[#8d8d9c] truncate">
                            {item.voice_name} • {fmtDate(item.created_at)}
                            {item.audio_available ? ` • ${fmtTime(item.duration_sec)}` : ` • ${item.status}`}
                          </div>
                        </div>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                            item.status === "completed"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : item.status === "partial" || item.status === "cancelled"
                              ? "bg-amber-500/15 text-amber-300"
                              : item.status === "failed"
                              ? "bg-red-500/15 text-red-300"
                              : "bg-[#282834] text-[#b4b4c4]"
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {item.audio_available && (
                          <button
                            onClick={() => void playHistoryItem(item)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#252532] hover:bg-[#323242] text-[#f0f0f5]"
                          >
                            <Play className="w-3 h-3 text-[#d4a373]" />
                            Replay
                          </button>
                        )}
                        <button
                          onClick={() => loadItemIntoEditor(item)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#252532] hover:bg-[#323242] text-[#c7c7d4]"
                        >
                          <FileText className="w-3 h-3" />
                          Load Text
                        </button>
                        {item.download_url && (
                          <a
                            href={resolveBackendUrl(item.download_url)}
                            download
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#252532] hover:bg-[#323242] text-[#c7c7d4]"
                          >
                            <Download className="w-3 h-3" />
                          </a>
                        )}
                        <button
                          onClick={() => void deleteHistoryItem(item.job_id)}
                          className="ml-auto p-1 rounded-lg text-red-400 hover:bg-red-500/15"
                          title="Delete saved output"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

