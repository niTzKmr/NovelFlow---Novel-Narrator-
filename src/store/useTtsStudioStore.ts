import { create } from "zustand";
import { resolveBackendUrl } from "../services/api";
import {
  ttsStudioApi,
  type StudioCapabilities,
  type StudioJobItem,
  type StudioVoice,
} from "../services/ttsStudioApi";

interface TtsStudioState {
  initialized: boolean;
  enabled: boolean;
  capabilities: StudioCapabilities | null;
  voices: StudioVoice[];
  selectedModelId: string;
  selectedVoiceId: string;
  title: string;
  text: string;
  language: "English" | "Auto";
  instruct: string;
  device: "auto" | "cuda" | "cpu";
  outputFormat: "wav" | "mp3" | "aac";
  chunkBatchSize: number;
  maxChunkChars: number;
  pauseMs: number;
  playbackSpeed: number;
  volume: number;

  activeJob: StudioJobItem | null;
  isGenerating: boolean;
  errorMsg: string | null;
  statusMsg: string | null;
  history: StudioJobItem[];

  previewingVoiceId: string | null;
  playingItem: StudioJobItem | null;
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;

  initStudio: (defaultModelId?: string, defaultVoiceId?: string, defaultDevice?: "auto" | "cuda" | "cpu") => Promise<void>;
  setEnabledFlag: (enabled: boolean) => Promise<void>;
  setField: <K extends keyof TtsStudioState>(key: K, val: TtsStudioState[K]) => void;
  refreshVoices: (modelId?: string) => Promise<void>;
  refreshHistory: () => Promise<void>;
  previewVoice: (voiceId: string) => Promise<void>;
  stopPreview: () => void;
  startGeneration: () => Promise<void>;
  cancelGeneration: () => Promise<void>;
  playHistoryItem: (item: StudioJobItem) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  replayAudio: () => Promise<void>;
  seekTo: (sec: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (vol: number) => void;
  deleteHistoryItem: (jobId: string) => Promise<void>;
  loadItemIntoEditor: (item: StudioJobItem) => void;
}

// Completely isolated HTMLAudio instances — never interferes with useAppStore audiobook audioEl
const studioAudioEl = typeof window !== "undefined" ? new Audio() : null;
const previewAudioEl = typeof window !== "undefined" ? new Audio() : null;
let studioPollTimer: number | null = null;

function stopStudioPoll() {
  if (studioPollTimer !== null) {
    window.clearInterval(studioPollTimer);
    studioPollTimer = null;
  }
}

export const useTtsStudioStore = create<TtsStudioState>((set, get) => {
  if (studioAudioEl) {
    studioAudioEl.addEventListener("timeupdate", () => {
      set({
        currentTimeSec: studioAudioEl.currentTime || 0,
        durationSec: Number.isFinite(studioAudioEl.duration) ? studioAudioEl.duration : get().durationSec,
      });
    });
    studioAudioEl.addEventListener("loadedmetadata", () => {
      set({
        durationSec: Number.isFinite(studioAudioEl.duration) ? studioAudioEl.duration : get().playingItem?.duration_sec || 0,
      });
    });
    studioAudioEl.addEventListener("ended", () => {
      set({ isPlaying: false, currentTimeSec: 0 });
    });
  }

  if (previewAudioEl) {
    previewAudioEl.addEventListener("ended", () => {
      set({ previewingVoiceId: null });
    });
  }

  return {
    initialized: false,
    enabled: true,
    capabilities: null,
    voices: [],
    selectedModelId: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    selectedVoiceId: "narrator-deep-cinematic",
    title: "",
    text: "",
    language: "English",
    instruct: "",
    device: "auto",
    outputFormat: "wav",
    chunkBatchSize: 1,
    maxChunkChars: 320,
    pauseMs: 220,
    playbackSpeed: 1.0,
    volume: 1.0,

    activeJob: null,
    isGenerating: false,
    errorMsg: null,
    statusMsg: null,
    history: [],

    previewingVoiceId: null,
    playingItem: null,
    isPlaying: false,
    currentTimeSec: 0,
    durationSec: 0,

    initStudio: async (defaultModelId, defaultVoiceId, defaultDevice) => {
      try {
        const caps = await ttsStudioApi.getConfig();
        const mid = defaultModelId || get().selectedModelId;
        set({
          initialized: true,
          enabled: caps.enabled,
          capabilities: caps,
          selectedModelId: mid,
          selectedVoiceId: defaultVoiceId || get().selectedVoiceId,
          device: defaultDevice || get().device,
        });
        if (caps.enabled) {
          await Promise.all([get().refreshVoices(mid), get().refreshHistory()]);
        }
      } catch {
        set({ initialized: true });
      }
    },

    setEnabledFlag: async (enabled) => {
      const caps = await ttsStudioApi.updateConfig(enabled);
      set({ enabled: caps.enabled, capabilities: caps });
      if (!caps.enabled) {
        stopStudioPoll();
        if (studioAudioEl) studioAudioEl.pause();
        if (previewAudioEl) previewAudioEl.pause();
        set({ isPlaying: false, previewingVoiceId: null, isGenerating: false });
      } else {
        await Promise.all([get().refreshVoices(get().selectedModelId), get().refreshHistory()]);
      }
    },

    setField: (key, val) => set({ [key]: val } as Partial<TtsStudioState>),

    refreshVoices: async (modelId) => {
      const mid = modelId || get().selectedModelId;
      try {
        const res = await ttsStudioApi.getVoices(mid);
        const curVoice = get().selectedVoiceId;
        const stillValid = res.voices.some((v) => v.voice_id === curVoice);
        set({
          selectedModelId: res.model_id,
          voices: res.voices,
          selectedVoiceId: stillValid ? curVoice : res.voices[0]?.voice_id || "",
        });
      } catch (err) {
        set({ errorMsg: err instanceof Error ? err.message : String(err) });
      }
    },

    refreshHistory: async () => {
      try {
        const res = await ttsStudioApi.getHistory(50);
        set({ history: res.items });
      } catch {
        // non-fatal
      }
    },

    previewVoice: async (voiceId) => {
      if (!previewAudioEl) return;
      if (get().previewingVoiceId === voiceId && !previewAudioEl.paused) {
        previewAudioEl.pause();
        set({ previewingVoiceId: null });
        return;
      }

      previewAudioEl.pause();
      set({ previewingVoiceId: voiceId, errorMsg: null });
      const { selectedModelId, device } = get();
      const baseUrl = resolveBackendUrl(
        `/api/tts-studio/voices/${encodeURIComponent(voiceId)}/preview?model_id=${encodeURIComponent(selectedModelId)}`
      );

      try {
        // Try instant cached file first; if uncached (preset voice), ask backend queue to synthesize 1 sentence
        const head = await fetch(baseUrl);
        let playUrl = baseUrl;
        if (head.status === 404) {
          set({ statusMsg: "Generating one-time sample preview on local Qwen3-TTS..." });
          const gen = await ttsStudioApi.generateVoicePreview(voiceId, selectedModelId, device);
          playUrl = resolveBackendUrl(gen.preview_url);
          await get().refreshVoices(selectedModelId);
        } else if (!head.ok) {
          throw new Error(`Preview unavailable (${head.status})`);
        }
        previewAudioEl.src = `${playUrl}&t=${Date.now()}`;
        await previewAudioEl.play();
        set({ statusMsg: null });
      } catch (err) {
        set({
          previewingVoiceId: null,
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      }
    },

    stopPreview: () => {
      if (previewAudioEl) previewAudioEl.pause();
      set({ previewingVoiceId: null });
    },

    startGeneration: async () => {
      const {
        text,
        title,
        selectedVoiceId,
        selectedModelId,
        language,
        instruct,
        device,
        outputFormat,
        chunkBatchSize,
        maxChunkChars,
        pauseMs,
      } = get();
      if (!text.trim()) {
        set({ errorMsg: "Enter or paste some text to synthesize." });
        return;
      }
      if (!selectedVoiceId) {
        set({ errorMsg: "Select a compatible voice profile first." });
        return;
      }

      stopStudioPoll();
      set({ isGenerating: true, errorMsg: null, statusMsg: "Submitting to local Qwen3-TTS queue..." });

      try {
        const job = await ttsStudioApi.generate({
          text,
          title: title.trim() || undefined,
          voice_id: selectedVoiceId,
          model_id: selectedModelId,
          language,
          instruct: instruct.trim() || undefined,
          device,
          output_format: outputFormat,
          chunk_batch_size: chunkBatchSize,
          max_chunk_chars: maxChunkChars,
          pause_ms: pauseMs,
        });
        set({ activeJob: job, statusMsg: job.waiting_for_queue ? "Waiting in GPU queue..." : "Synthesizing..." });

        studioPollTimer = window.setInterval(async () => {
          try {
            const latest = await ttsStudioApi.getJob(job.job_id);
            set({ activeJob: latest });
            const terminal =
              latest.status === "completed" ||
              latest.status === "partial" ||
              latest.status === "cancelled" ||
              latest.status === "failed";
            if (terminal) {
              stopStudioPoll();
              set({ isGenerating: false });
              await get().refreshHistory();

              if (latest.audio_available) {
                set({
                  statusMsg:
                    latest.status === "completed"
                      ? `Generated ${latest.duration_sec.toFixed(1)}s across ${latest.total_chunks} chunk(s).`
                      : latest.error_message || "Partial audio preserved.",
                  errorMsg: latest.status === "partial" ? latest.error_message : null,
                });
                await get().playHistoryItem(latest);
              } else if (latest.status === "failed") {
                set({ errorMsg: latest.error_message || "Generation failed.", statusMsg: null });
              } else {
                set({ statusMsg: "Generation canceled." });
              }
            } else {
              set({
                statusMsg: latest.waiting_for_queue
                  ? `Waiting for GPU queue (${latest.queue_active_task || "active job"} ahead)...`
                  : `Generating chunk ${Math.min(latest.completed_chunks + 1, latest.total_chunks)} of ${latest.total_chunks}...`,
              });
            }
          } catch (pollErr) {
            stopStudioPoll();
            set({
              isGenerating: false,
              errorMsg: pollErr instanceof Error ? pollErr.message : String(pollErr),
            });
          }
        }, 400);
      } catch (err) {
        set({
          isGenerating: false,
          statusMsg: null,
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      }
    },

    cancelGeneration: async () => {
      const job = get().activeJob;
      if (!job) return;
      try {
        const res = await ttsStudioApi.cancelJob(job.job_id);
        set({ activeJob: res, statusMsg: "Canceling after current chunk finishes..." });
      } catch (err) {
        set({ errorMsg: err instanceof Error ? err.message : String(err) });
      }
    },

    playHistoryItem: async (item) => {
      if (!studioAudioEl || !item.audio_url) return;
      const { playbackSpeed, volume } = get();
      const targetUrl = `${resolveBackendUrl(item.audio_url)}?t=${encodeURIComponent(item.updated_at)}`;
      if (studioAudioEl.src !== targetUrl) {
        studioAudioEl.src = targetUrl;
      }
      studioAudioEl.playbackRate = playbackSpeed;
      studioAudioEl.volume = volume;
      set({ playingItem: item, durationSec: item.duration_sec || 0, currentTimeSec: 0, isPlaying: true });
      try {
        await studioAudioEl.play();
      } catch {
        set({ isPlaying: false });
      }
    },

    togglePlayPause: async () => {
      if (!studioAudioEl || !get().playingItem) return;
      if (!studioAudioEl.paused) {
        studioAudioEl.pause();
        set({ isPlaying: false });
      } else {
        studioAudioEl.playbackRate = get().playbackSpeed;
        studioAudioEl.volume = get().volume;
        set({ isPlaying: true });
        await studioAudioEl.play().catch(() => set({ isPlaying: false }));
      }
    },

    replayAudio: async () => {
      const item = get().playingItem;
      if (!studioAudioEl || !item) return;
      studioAudioEl.currentTime = 0;
      studioAudioEl.playbackRate = get().playbackSpeed;
      studioAudioEl.volume = get().volume;
      set({ currentTimeSec: 0, isPlaying: true });
      await studioAudioEl.play().catch(() => set({ isPlaying: false }));
    },

    seekTo: (sec) => {
      if (!studioAudioEl || !studioAudioEl.src) return;
      const dur = Number.isFinite(studioAudioEl.duration) ? studioAudioEl.duration : get().durationSec;
      const clamped = Math.max(0, Math.min(dur, sec));
      studioAudioEl.currentTime = clamped;
      set({ currentTimeSec: clamped });
    },

    setPlaybackSpeed: (speed) => {
      if (studioAudioEl) studioAudioEl.playbackRate = speed;
      set({ playbackSpeed: speed });
    },

    setVolume: (vol) => {
      const clamped = Math.max(0, Math.min(1, vol));
      if (studioAudioEl) studioAudioEl.volume = clamped;
      set({ volume: clamped });
    },

    deleteHistoryItem: async (jobId) => {
      await ttsStudioApi.deleteItem(jobId);
      if (get().playingItem?.job_id === jobId && studioAudioEl) {
        studioAudioEl.pause();
        studioAudioEl.src = "";
        set({ playingItem: null, isPlaying: false, currentTimeSec: 0, durationSec: 0 });
      }
      await get().refreshHistory();
    },

    loadItemIntoEditor: (item) => {
      const prevModel = get().selectedModelId;
      set({
        title: item.title,
        text: item.input_text,
        selectedModelId: item.model_id,
        selectedVoiceId: item.voice_id,
        language: item.language === "Auto" ? "Auto" : "English",
        instruct: item.instruct || "",
      });
      if (item.model_id !== prevModel) {
        void get().refreshVoices(item.model_id);
      }
    },
  };
});

