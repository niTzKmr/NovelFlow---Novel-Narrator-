import { create } from "zustand";
import { api, resolveBackendUrl } from "../services/api";
import type {
  AppSettings,
  AudioChunkStatus,
  BookDetail,
  BookSummary,
  BookmarkItem,
  ChapterAudioStatus,
  ChapterContent,
  HardwareStatus,
  HighlightItem,
  ModelInfo,
  PageId,
  ReaderPreferences,
  VoiceProfile,
} from "../types";

interface SleepTimerState {
  mode: "off" | "minutes" | "end_of_chapter";
  remainingSec: number;
}

interface AppState {
  page: PageId;
  backendReady: boolean;
  hardware: HardwareStatus | null;
  models: ModelInfo[];
  voices: VoiceProfile[];
  books: BookSummary[];
  settings: AppSettings | null;
  showFirstRunWizard: boolean;
  errorToast: string | null;

  // Active reading book state
  activeBook: BookDetail | null;
  activeChapter: ChapterContent | null;
  bookmarks: BookmarkItem[];
  highlights: HighlightItem[];
  isFullscreen: boolean;

  // Audiobook playback & sync state
  audioStatus: ChapterAudioStatus | null;
  activeJobId: string | null;
  isPlaying: boolean;
  isBuffering: boolean;
  currentChunkIndex: number;
  activeSentenceIndex: number | null;
  chunkCurrentTimeSec: number;
  chunkDurationSec: number;
  playbackSpeed: number;
  volume: number;
  sleepTimer: SleepTimerState;

  // Actions
  setPage: (p: PageId) => void;
  setErrorToast: (msg: string | null) => void;
  dismissWizard: () => void;
  bootstrap: () => Promise<void>;
  refreshModelsAndVoices: () => Promise<void>;
  refreshBooks: () => Promise<void>;
  updateReaderPrefs: (patch: Partial<ReaderPreferences>) => Promise<void>;
  updateAppSettings: (patch: Record<string, unknown>) => Promise<void>;

  openBook: (bookId: string, overrideChapterIndex?: number, overrideSentenceIndex?: number) => Promise<void>;
  loadChapter: (chapterId: string, startSentenceIndex?: number, autoPlay?: boolean) => Promise<void>;
  refreshAnnotations: (bookId: string) => Promise<void>;
  toggleFullscreen: () => Promise<void>;

  // Audio controls
  startNarration: (startSentenceIndex?: number) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  pauseAudio: () => void;
  seekRelative: (deltaSec: number) => void;
  jumpParagraph: (direction: -1 | 1) => Promise<void>;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (vol: number) => void;
  setSleepTimer: (mode: "off" | "minutes" | "end_of_chapter", minutes?: number) => void;
  refreshChapterAudioStatus: () => Promise<void>;
  cancelActiveJob: () => Promise<void>;
}

const audioEl = typeof window !== "undefined" ? new Audio() : null;
let pollTimer: number | null = null;
let sleepInterval: number | null = null;
let lastProgressPersistAt = 0;

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useAppStore = create<AppState>((set, get) => {
  const persistCurrentPosition = (isPlayingNow: boolean) => {
    const { activeBook, activeChapter, activeSentenceIndex, chunkCurrentTimeSec } = get();
    if (!activeBook || !activeChapter) return;
    const totalChapters = Math.max(1, activeBook.total_chapters);
    const totalSentences = Math.max(1, activeChapter.sentences.length);
    const sentIdx = activeSentenceIndex ?? 0;
    const chapFraction = sentIdx / totalSentences;
    const pct = ((activeChapter.chapter_index + chapFraction) / totalChapters) * 100;
    api
      .saveProgress(activeBook.book_id, {
        chapter_id: activeChapter.chapter_id,
        chapter_index: activeChapter.chapter_index,
        sentence_index: sentIdx,
        audio_position_sec: chunkCurrentTimeSec,
        progress_pct: Math.min(100, Math.max(0, Number(pct.toFixed(1)))),
        is_audio_playing: isPlayingNow,
      })
      .catch(() => {});
  };

  const playChunk = async (chunk: AudioChunkStatus, seekOffsetSec = 0) => {
    if (!audioEl || !chunk.audio_url) return;
    const url = resolveBackendUrl(chunk.audio_url);
    if (audioEl.src !== url) {
      audioEl.src = url;
    }
    audioEl.playbackRate = get().playbackSpeed;
    audioEl.volume = get().volume;
    if (seekOffsetSec > 0) {
      audioEl.currentTime = seekOffsetSec;
    }
    set({
      currentChunkIndex: chunk.chunk_index,
      activeSentenceIndex: chunk.sentence_start,
      isBuffering: false,
      isPlaying: true,
    });
    try {
      await audioEl.play();
      persistCurrentPosition(true);
    } catch (err) {
      set({
        isPlaying: false,
        errorToast: `Audio playback could not start: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const syncSentenceFromTime = () => {
    if (!audioEl) return;
    const { audioStatus, currentChunkIndex } = get();
    if (!audioStatus) return;
    const chunk = audioStatus.chunks[currentChunkIndex];
    if (!chunk) return;
    const t = audioEl.currentTime || 0;
    let resolvedSentence = chunk.sentence_start;
    if (chunk.sentence_timings.length > 0) {
      for (const st of chunk.sentence_timings) {
        if (t >= st.start_sec - 0.05 && t <= st.end_sec + 0.16) {
          resolvedSentence = st.sentence_index;
          break;
        }
        if (t > st.end_sec) {
          resolvedSentence = st.sentence_index;
        }
      }
    }
    if (resolvedSentence !== get().activeSentenceIndex || Math.abs(t - get().chunkCurrentTimeSec) > 0.2) {
      set({
        activeSentenceIndex: resolvedSentence,
        chunkCurrentTimeSec: t,
        chunkDurationSec: Number.isFinite(audioEl.duration) ? audioEl.duration : chunk.duration_sec || 0,
      });
    }
    const now = Date.now();
    if (now - lastProgressPersistAt > 5000 && get().isPlaying) {
      lastProgressPersistAt = now;
      persistCurrentPosition(true);
    }
  };

  if (audioEl) {
    audioEl.addEventListener("timeupdate", syncSentenceFromTime);
    audioEl.addEventListener("loadedmetadata", () => {
      set({ chunkDurationSec: Number.isFinite(audioEl.duration) ? audioEl.duration : 0 });
    });
    audioEl.addEventListener("ended", async () => {
      const state = get();
      const status = state.audioStatus;
      if (!status) return;
      const nextIdx = state.currentChunkIndex + 1;
      if (nextIdx < status.chunks.length) {
        const nextChunk = status.chunks[nextIdx];
        if (nextChunk.status === "cached" && nextChunk.audio_url) {
          await playChunk(nextChunk, 0);
        } else {
          set({
            currentChunkIndex: nextIdx,
            activeSentenceIndex: nextChunk.sentence_start,
            isBuffering: true,
            isPlaying: true,
          });
          api.prioritizeSentence(status.chapter_id, nextChunk.sentence_start).catch(() => {});
        }
        return;
      }

      // End of chapter reached
      if (state.sleepTimer.mode === "end_of_chapter") {
        set({ isPlaying: false, isBuffering: false, sleepTimer: { mode: "off", remainingSec: 0 } });
        persistCurrentPosition(false);
        return;
      }

      const autoContinue = state.settings?.reader?.auto_continue_chapter ?? true;
      const book = state.activeBook;
      const ch = state.activeChapter;
      if (autoContinue && book && ch && ch.chapter_index + 1 < book.chapters.length) {
        const nextCh = book.chapters[ch.chapter_index + 1];
        await get().loadChapter(nextCh.chapter_id, 0, true);
      } else {
        set({ isPlaying: false, isBuffering: false });
        persistCurrentPosition(false);
      }
    });
  }

  return {
    page: "home",
    backendReady: false,
    hardware: null,
    models: [],
    voices: [],
    books: [],
    settings: null,
    showFirstRunWizard: false,
    errorToast: null,

    activeBook: null,
    activeChapter: null,
    bookmarks: [],
    highlights: [],
    isFullscreen: false,

    audioStatus: null,
    activeJobId: null,
    isPlaying: false,
    isBuffering: false,
    currentChunkIndex: 0,
    activeSentenceIndex: null,
    chunkCurrentTimeSec: 0,
    chunkDurationSec: 0,
    playbackSpeed: 1.0,
    volume: 1.0,
    sleepTimer: { mode: "off", remainingSec: 0 },

    setPage: (p) => set({ page: p }),
    setErrorToast: (msg) => set({ errorToast: msg }),
    dismissWizard: () => set({ showFirstRunWizard: false }),

    bootstrap: async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const [hw, models, voices, books, cfg] = await Promise.all([
            api.getHardware(),
            api.getModels(),
            api.getVoices(),
            api.getBooks(),
            api.getSettings(),
          ]);
          const anyDownloaded = models.some((m) => m.is_downloaded);
          set({
            backendReady: true,
            errorToast: null,
            hardware: hw,
            models,
            voices,
            books,
            settings: cfg,
            showFirstRunWizard: !anyDownloaded,
            page: cfg.startup_behavior === "library" ? "library" : "home",
          });
          return;
        } catch (err) {
          if (attempt === 29) {
            set({
              backendReady: false,
              errorToast: `Local backend offline: ${err instanceof Error ? err.message : String(err)}`,
            });
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    },

    refreshModelsAndVoices: async () => {
      const [models, voices] = await Promise.all([api.getModels(), api.getVoices()]);
      set({ models, voices });
    },

    refreshBooks: async () => {
      const books = await api.getBooks();
      set({ books });
    },

    updateReaderPrefs: async (patch) => {
      const current = get().settings;
      if (!current) return;
      const mergedReader = { ...current.reader, ...patch };
      const updated = await api.updateSettings({ reader: mergedReader });
      set({ settings: updated });
    },

    updateAppSettings: async (patch) => {
      const updated = await api.updateSettings(patch);
      set({ settings: updated });
    },

    openBook: async (bookId, overrideChapterIndex, overrideSentenceIndex) => {
      const detail = await api.getBook(bookId);
      set({ activeBook: detail, page: "reader" });
      await get().refreshAnnotations(bookId);
      const targetChapterIdx =
        overrideChapterIndex !== undefined
          ? overrideChapterIndex
          : detail.position?.chapter_index ?? 0;
      const targetChap = detail.chapters[targetChapterIdx] || detail.chapters[0];
      const targetSent =
        overrideSentenceIndex !== undefined
          ? overrideSentenceIndex
          : detail.position?.sentence_index ?? 0;
      if (targetChap) {
        await get().loadChapter(targetChap.chapter_id, targetSent, false);
      }
    },

    loadChapter: async (chapterId, startSentenceIndex = 0, autoPlay = false) => {
      stopPolling();
      if (audioEl) {
        audioEl.pause();
      }
      const chap = await api.getChapter(chapterId);
      const cfg = get().settings;
      const status = await api.getChapterAudioStatus(
        chapterId,
        cfg?.preferred_voice_id,
        cfg?.active_model_id
      );
      set({
        activeChapter: chap,
        audioStatus: status,
        activeSentenceIndex: startSentenceIndex,
        isPlaying: false,
        isBuffering: false,
        currentChunkIndex: 0,
        chunkCurrentTimeSec: 0,
      });
      persistCurrentPosition(false);
      await get().refreshBooks();
      if (autoPlay) {
        await get().startNarration(startSentenceIndex);
      }
    },

    refreshAnnotations: async (bookId) => {
      const [bookmarks, highlights] = await Promise.all([
        api.getBookmarks(bookId),
        api.getHighlights(bookId),
      ]);
      set({ bookmarks, highlights });
    },

    toggleFullscreen: async () => {
      if (window.novelflow) {
        const fs = await window.novelflow.toggleFullscreen();
        set({ isFullscreen: fs });
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        set({ isFullscreen: false });
      } else {
        await document.documentElement.requestFullscreen();
        set({ isFullscreen: true });
      }
    },

    startNarration: async (startSentenceIndex) => {
      const { activeChapter, settings: cfg, activeSentenceIndex } = get();
      if (!activeChapter || !cfg) return;
      const targetSentence = startSentenceIndex ?? activeSentenceIndex ?? 0;

      // Ensure voice/model compatibility cleanly before starting
      const selectedModel = cfg.active_model_id;
      const selectedVoice = cfg.preferred_voice_id;
      const voiceObj = get().voices.find((v) => v.voice_id === selectedVoice);
      if (voiceObj && !voiceObj.compatible_models.includes(selectedModel)) {
        set({
          errorToast: `Preferred voice "${voiceObj.name}" is incompatible with active model "${selectedModel.split("/").pop()}". Switch model or voice in Voice Lab / Settings.`,
        });
        return;
      }

      set({ isBuffering: true, isPlaying: true, activeSentenceIndex: targetSentence });

      try {
        const res = await api.generateChapterAudio({
          chapter_id: activeChapter.chapter_id,
          voice_id: selectedVoice,
          model_id: selectedModel,
          start_sentence_index: targetSentence,
          device: cfg.device_preference,
          pregenerate_next: cfg.pregenerate_next_chapter,
        });

        set({ audioStatus: res.chapter_status, activeJobId: res.job_id });

        const findAndMaybePlay = async (status: ChapterAudioStatus): Promise<boolean> => {
          let chunkIdx = status.chunks.findIndex(
            (c) => targetSentence >= c.sentence_start && targetSentence <= c.sentence_end
          );
          if (chunkIdx < 0) chunkIdx = 0;
          const targetChunk = status.chunks[chunkIdx];
          if (targetChunk && targetChunk.status === "cached" && targetChunk.audio_url) {
            let offset = 0;
            const st = targetChunk.sentence_timings.find((t) => t.sentence_index === targetSentence);
            if (st) offset = st.start_sec;
            await playChunk(targetChunk, offset);
            return true;
          }
          return false;
        };

        const startedImmediately = await findAndMaybePlay(res.chapter_status);

        stopPolling();
        if (!res.chapter_status.complete) {
          pollTimer = window.setInterval(async () => {
            const curChap = get().activeChapter;
            if (!curChap || curChap.chapter_id !== activeChapter.chapter_id) {
              stopPolling();
              return;
            }
            const updatedStatus = await api.getChapterAudioStatus(
              activeChapter.chapter_id,
              selectedVoice,
              selectedModel
            );
            set({ audioStatus: updatedStatus });

            if (get().isPlaying && get().isBuffering) {
              const idx = get().currentChunkIndex;
              const waitingForStart = !startedImmediately && idx === 0;
              const targetChunk = waitingForStart
                ? updatedStatus.chunks.find(
                    (c) => targetSentence >= c.sentence_start && targetSentence <= c.sentence_end
                  )
                : updatedStatus.chunks[idx];
              if (targetChunk && targetChunk.status === "cached" && targetChunk.audio_url) {
                let offset = 0;
                if (waitingForStart) {
                  const st = targetChunk.sentence_timings.find((t) => t.sentence_index === targetSentence);
                  if (st) offset = st.start_sec;
                }
                await playChunk(targetChunk, offset);
              }
            }

            if (updatedStatus.complete) {
              stopPolling();
              set({ activeJobId: null });
            }
          }, 450);
        } else if (!startedImmediately) {
          set({ isBuffering: false, isPlaying: false });
        }
      } catch (err) {
        set({
          isBuffering: false,
          isPlaying: false,
          errorToast: err instanceof Error ? err.message : String(err),
        });
      }
    },

    togglePlayPause: async () => {
      if (!audioEl) return;
      const { isPlaying, audioStatus, currentChunkIndex, activeSentenceIndex } = get();
      if (isPlaying) {
        audioEl.pause();
        set({ isPlaying: false, isBuffering: false });
        persistCurrentPosition(false);
        return;
      }
      const chunk = audioStatus?.chunks[currentChunkIndex];
      if (chunk && chunk.status === "cached" && chunk.audio_url && audioEl.src) {
        set({ isPlaying: true, isBuffering: false });
        await audioEl.play();
        persistCurrentPosition(true);
      } else {
        await get().startNarration(activeSentenceIndex ?? 0);
      }
    },

    pauseAudio: () => {
      if (audioEl) audioEl.pause();
      set({ isPlaying: false, isBuffering: false });
      persistCurrentPosition(false);
    },

    seekRelative: (deltaSec) => {
      if (!audioEl || !audioEl.src) return;
      const dur = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
      const nextTime = Math.max(0, Math.min(dur, audioEl.currentTime + deltaSec));
      audioEl.currentTime = nextTime;
      syncSentenceFromTime();
    },

    jumpParagraph: async (direction) => {
      const { activeChapter, activeSentenceIndex, isPlaying } = get();
      if (!activeChapter || activeChapter.sentences.length === 0) return;
      const curIdx = activeSentenceIndex ?? 0;
      const curPara =
        activeChapter.sentences.find((s) => s.sentence_index === curIdx)?.paragraph_index ?? 0;
      const targetPara = Math.max(0, curPara + direction);
      const targetSent =
        activeChapter.sentences.find((s) => s.paragraph_index === targetPara) ||
        (direction > 0
          ? activeChapter.sentences[activeChapter.sentences.length - 1]
          : activeChapter.sentences[0]);
      if (targetSent) {
        if (isPlaying) {
          await get().startNarration(targetSent.sentence_index);
        } else {
          set({ activeSentenceIndex: targetSent.sentence_index });
        }
      }
    },

    setPlaybackSpeed: (speed) => {
      if (audioEl) audioEl.playbackRate = speed;
      set({ playbackSpeed: speed });
    },

    setVolume: (vol) => {
      const clamped = Math.max(0, Math.min(1, vol));
      if (audioEl) audioEl.volume = clamped;
      set({ volume: clamped });
    },

    setSleepTimer: (mode, minutes = 15) => {
      if (sleepInterval !== null) {
        window.clearInterval(sleepInterval);
        sleepInterval = null;
      }
      if (mode === "off") {
        set({ sleepTimer: { mode: "off", remainingSec: 0 } });
        return;
      }
      if (mode === "end_of_chapter") {
        set({ sleepTimer: { mode: "end_of_chapter", remainingSec: 0 } });
        return;
      }
      set({ sleepTimer: { mode: "minutes", remainingSec: minutes * 60 } });
      sleepInterval = window.setInterval(() => {
        const st = get().sleepTimer;
        if (st.mode !== "minutes") {
          if (sleepInterval !== null) window.clearInterval(sleepInterval);
          return;
        }
        if (st.remainingSec <= 1) {
          if (sleepInterval !== null) window.clearInterval(sleepInterval);
          sleepInterval = null;
          get().pauseAudio();
          set({ sleepTimer: { mode: "off", remainingSec: 0 } });
        } else {
          set({ sleepTimer: { mode: "minutes", remainingSec: st.remainingSec - 1 } });
        }
      }, 1000);
    },

    refreshChapterAudioStatus: async () => {
      const { activeChapter, settings: cfg } = get();
      if (!activeChapter || !cfg) return;
      const st = await api.getChapterAudioStatus(
        activeChapter.chapter_id,
        cfg.preferred_voice_id,
        cfg.active_model_id
      );
      set({ audioStatus: st });
    },

    cancelActiveJob: async () => {
      const { activeJobId } = get();
      if (!activeJobId) return;
      await api.cancelJob(activeJobId);
      stopPolling();
      set({ activeJobId: null, isBuffering: false, isPlaying: false });
    },
  };
});

