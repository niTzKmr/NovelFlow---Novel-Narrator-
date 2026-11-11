import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Square,
  Volume2,
} from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../store/useAppStore";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudiobookPlayerBar() {
  const {
    activeBook,
    activeChapter,
    audioStatus,
    isPlaying,
    isBuffering,
    currentChunkIndex,
    chunkCurrentTimeSec,
    chunkDurationSec,
    playbackSpeed,
    volume,
    sleepTimer,
    voices,
    settings,
    togglePlayPause,
    seekRelative,
    jumpParagraph,
    setPlaybackSpeed,
    setVolume,
    setSleepTimer,
    cancelActiveJob,
    activeJobId,
  } = useAppStore();

  const [showSleepMenu, setShowSleepMenu] = useState(false);

  if (!activeBook || !activeChapter) return null;

  const preferredVoice = voices.find((v) => v.voice_id === settings?.preferred_voice_id);
  const cachedCount = audioStatus?.cached_chunks ?? 0;
  const totalChunks = audioStatus?.total_chunks ?? 0;

  // Estimate remaining cached duration across remaining chunks
  const remainingCachedSec = (audioStatus?.chunks || [])
    .slice(currentChunkIndex)
    .reduce((acc, c, idx) => {
      if (!c.duration_sec) return acc;
      return acc + (idx === 0 ? Math.max(0, c.duration_sec - chunkCurrentTimeSec) : c.duration_sec);
    }, 0);

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(playbackSpeed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setPlaybackSpeed(next);
  };

  return (
    <footer className="h-[74px] shrink-0 bg-[#141419] border-t border-[#25252f] px-5 flex items-center justify-between gap-4 select-none">
      {/* Left: Book / Chapter / Narrator */}
      <div className="min-w-0 w-72 flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[#f0f0f4] truncate">{activeChapter.title}</div>
          <div className="text-[11.5px] text-[#8e8e9b] truncate">
            {activeBook.title} • {preferredVoice?.name || "Narrator"}
          </div>
        </div>
      </div>

      {/* Center: Transport & Chunk Progress */}
      <div className="flex flex-col items-center gap-1.5 flex-1 max-w-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={() => jumpParagraph(-1)}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222b]"
            title="Previous Paragraph"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => seekRelative(-10)}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222b]"
            title="Back 10s"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={() => togglePlayPause()}
            className="w-9 h-9 rounded-full bg-[#d4a373] text-[#141210] flex items-center justify-center hover:brightness-105 transition"
            title={isPlaying ? "Pause Narration" : "Play Narration"}
          >
            {isBuffering ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>
          <button
            onClick={() => seekRelative(10)}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222b]"
            title="Forward 10s"
          >
            <RotateCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => jumpParagraph(1)}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222b]"
            title="Next Paragraph"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="w-full flex items-center gap-2.5 text-[11px] text-[#878796]">
          <span className="w-9 text-right tabular-nums">{formatDuration(chunkCurrentTimeSec)}</span>
          <div className="flex-1 h-1.5 rounded-full bg-[#24242d] overflow-hidden relative">
            <div
              className="h-full bg-[#d4a373]/30 absolute left-0 top-0 transition-all"
              style={{ width: totalChunks > 0 ? `${(cachedCount / totalChunks) * 100}%` : "0%" }}
              title={`Cached ${cachedCount}/${totalChunks} segments`}
            />
            <div
              className="h-full bg-[#d4a373] relative transition-all"
              style={{
                width:
                  totalChunks > 0
                    ? `${Math.min(100, ((currentChunkIndex + (chunkDurationSec ? chunkCurrentTimeSec / chunkDurationSec : 0)) / totalChunks) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          <span className="w-24 tabular-nums">
            {remainingCachedSec > 0
              ? `-${formatDuration(remainingCachedSec)}`
              : `${cachedCount}/${totalChunks} segs`}
          </span>
        </div>
      </div>

      {/* Right: Speed, Sleep Timer, Volume, Stop Job */}
      <div className="w-72 flex items-center justify-end gap-2.5 relative">
        {activeJobId && (
          <button
            onClick={() => cancelActiveJob()}
            className="px-2 py-1 rounded-md bg-[#23232c] border border-[#343440] text-[11px] text-amber-300 hover:text-white flex items-center gap-1"
            title="Stop background audio generation"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>{cachedCount}/{totalChunks}</span>
          </button>
        )}

        <button
          onClick={cycleSpeed}
          className="px-2.5 py-1 rounded-md bg-[#1f1f27] border border-[#2c2c37] text-xs font-medium text-[#e4e4ea] hover:border-[#d4a373]/50 tabular-nums"
          title="Playback Speed"
        >
          {playbackSpeed}x
        </button>

        <div className="relative">
          <button
            onClick={() => setShowSleepMenu((s) => !s)}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1 ${
              sleepTimer.mode !== "off"
                ? "border-[#d4a373]/50 bg-[#d4a373]/15 text-[#d4a373]"
                : "border-transparent text-[#9d9daa] hover:text-white hover:bg-[#22222b]"
            }`}
            title="Sleep Timer"
          >
            <Clock className="w-4 h-4" />
            {sleepTimer.mode === "minutes" && <span className="tabular-nums">{Math.ceil(sleepTimer.remainingSec / 60)}m</span>}
            {sleepTimer.mode === "end_of_chapter" && <span>Ch</span>}
          </button>

          {showSleepMenu && (
            <div className="absolute bottom-10 right-0 w-44 rounded-xl bg-[#1c1c23] border border-[#2e2e3a] shadow-xl p-1.5 z-40 text-xs">
              {[
                { label: "Timer Off", mode: "off" as const },
                { label: "15 minutes", mode: "minutes" as const, min: 15 },
                { label: "30 minutes", mode: "minutes" as const, min: 30 },
                { label: "45 minutes", mode: "minutes" as const, min: 45 },
                { label: "60 minutes", mode: "minutes" as const, min: 60 },
                { label: "End of Chapter", mode: "end_of_chapter" as const },
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => {
                    setSleepTimer(opt.mode, opt.min);
                    setShowSleepMenu(false);
                  }}
                  className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-[#272731] text-[#e4e4ea]"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 w-24">
          <Volume2 className="w-4 h-4 text-[#8e8e9b] shrink-0" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-full accent-[#d4a373] cursor-pointer"
          />
        </div>
      </div>
    </footer>
  );
}

