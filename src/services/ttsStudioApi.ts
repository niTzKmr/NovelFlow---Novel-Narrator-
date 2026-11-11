import { resolveBackendUrl } from "./api";
import type { VoiceProfile } from "../types";

export interface StudioQueueState {
  busy: boolean;
  active_task: string | null;
  pending_count: number;
}

export interface StudioCapabilities {
  enabled: boolean;
  ffmpeg_available: boolean;
  supported_output_formats: string[];
  supports_generation_speed: boolean;
  supports_elevenlabs_sliders: boolean;
  playback_speed_range: [number, number];
  pause_ms_range: [number, number];
  chunk_batch_range: [number, number];
  max_chunk_chars_range: [number, number];
  queue_state?: StudioQueueState;
}

export interface StudioVoice extends VoiceProfile {
  preview_ready: boolean;
  preview_url: string;
}

export interface StudioPlanStats {
  char_count: number;
  word_count: number;
  paragraph_count: number;
  sentence_count: number;
  chunk_count: number;
  queue_state: StudioQueueState;
}

export interface StudioJobItem {
  job_id: string;
  title: string;
  input_text: string;
  voice_id: string;
  voice_name: string;
  model_id: string;
  language: string;
  instruct: string | null;
  device: string;
  output_format: string;
  chunk_batch_size: number;
  max_chunk_chars: number;
  pause_ms: number;
  status: "queued" | "running" | "completed" | "partial" | "cancelled" | "failed";
  total_chunks: number;
  completed_chunks: number;
  current_chunk_text: string | null;
  audio_path: string | null;
  audio_format: string | null;
  duration_sec: number;
  sample_rate: number;
  size_bytes: number;
  warning: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  audio_available: boolean;
  audio_url: string | null;
  download_url: string | null;
  waiting_for_queue: boolean;
  queue_active_task: string | null;
}

async function studioRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveBackendUrl(path), init);
  if (!res.ok) {
    let msg = `TTS Studio request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.detail) msg = String(data.detail);
    } catch {
      // ignore json parse failure
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const ttsStudioApi = {
  getConfig: () => studioRequest<StudioCapabilities>("/api/tts-studio/config"),

  updateConfig: (enabled: boolean) =>
    studioRequest<StudioCapabilities>("/api/tts-studio/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),

  getVoices: (modelId?: string) => {
    const qs = modelId ? `?model_id=${encodeURIComponent(modelId)}` : "";
    return studioRequest<{ model_id: string; voices: StudioVoice[] }>(`/api/tts-studio/voices${qs}`);
  },

  generateVoicePreview: (voiceId: string, modelId: string, device: string) =>
    studioRequest<{ ok: boolean; voice_id: string; model_id: string; preview_url: string }>(
      `/api/tts-studio/voices/${encodeURIComponent(voiceId)}/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: modelId, device }),
      }
    ),

  getPlan: (payload: { text: string; chunk_batch_size: number; max_chunk_chars: number }) =>
    studioRequest<StudioPlanStats>("/api/tts-studio/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  generate: (payload: {
    text: string;
    title?: string;
    voice_id: string;
    model_id: string;
    language: string;
    instruct?: string;
    device: string;
    output_format: string;
    chunk_batch_size: number;
    max_chunk_chars: number;
    pause_ms: number;
  }) =>
    studioRequest<StudioJobItem>("/api/tts-studio/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  getJob: (jobId: string) =>
    studioRequest<StudioJobItem>(`/api/tts-studio/jobs/${encodeURIComponent(jobId)}`),

  cancelJob: (jobId: string) =>
    studioRequest<StudioJobItem>(`/api/tts-studio/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    }),

  getHistory: (limit = 40) =>
    studioRequest<{ items: StudioJobItem[] }>(`/api/tts-studio/history?limit=${limit}`),

  deleteItem: (jobId: string) =>
    studioRequest<{ ok: boolean; deleted_job_id: string }>(
      `/api/tts-studio/items/${encodeURIComponent(jobId)}`,
      { method: "DELETE" }
    ),
};

