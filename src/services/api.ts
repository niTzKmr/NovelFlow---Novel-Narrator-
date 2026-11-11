import type {
  AppSettings,
  BookDetail,
  BookSummary,
  BookmarkItem,
  ChapterAudioStatus,
  ChapterContent,
  HardwareStatus,
  HighlightItem,
  LabSample,
  ModelInfo,
  SearchHit,
  StorageStats,
  VoiceProfile,
} from "../types";

export const BACKEND_ORIGIN =
  typeof window !== "undefined" && window.location.protocol === "file:"
    ? "http://127.0.0.1:8765"
    : typeof window !== "undefined" && window.location.port === "5173"
    ? ""
    : "http://127.0.0.1:8765";

export function resolveBackendUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${BACKEND_ORIGIN}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveBackendUrl(path), init);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
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

export const api = {
  health: () =>
    request<{
      status: string;
      local_only: boolean;
      telemetry_enabled: boolean;
      active_engine: { model_id: string | null; device: string | null; dtype: string | null; loaded: boolean };
    }>("/api/health"),

  getHardware: () => request<HardwareStatus>("/api/system/hardware"),

  getModels: () => request<ModelInfo[]>("/api/models"),

  downloadModel: (modelId: string) =>
    request<{ model_id: string; status: string; local_path: string; error?: string }>("/api/models/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
    }),

  getDownloadStatus: (modelId: string) =>
    request<{ model_id: string; status: string; local_path: string; error?: string }>(
      `/api/models/download/${encodeURIComponent(modelId)}`
    ),

  loadModel: (modelId: string, device: "auto" | "cuda" | "cpu" = "auto") =>
    request<{ status: string; load_sec: number; warning: string | null }>("/api/models/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId, device }),
    }),

  getVoices: (modelId?: string) =>
    request<VoiceProfile[]>(modelId ? `/api/voices?model_id=${encodeURIComponent(modelId)}` : "/api/voices"),

  designVoice: (payload: {
    name: string;
    description: string;
    instruct: string;
    reference_text?: string;
    device?: "auto" | "cuda" | "cpu";
  }) =>
    request<{ profile: VoiceProfile; metrics: Record<string, unknown> }>("/api/voices/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  cloneVoice: (formData: FormData) =>
    request<VoiceProfile>("/api/voices/clone", {
      method: "POST",
      body: formData,
    }),

  preferVoice: (voiceId: string) =>
    request<VoiceProfile>(`/api/voices/${encodeURIComponent(voiceId)}/prefer`, { method: "POST" }),

  deleteVoice: (voiceId: string) =>
    request<{ deleted: boolean }>(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" }),

  getLabMeta: () =>
    request<{ fixed_sample_script: string; calibration_passage: string }>("/api/tts/lab/meta"),

  getLabSamples: () => request<LabSample[]>("/api/tts/lab/samples"),

  generateLabSample: (payload: {
    voice_id: string;
    model_id: string;
    text: string;
    instruct?: string | null;
    device: "auto" | "cuda" | "cpu";
  }) =>
    request<LabSample>("/api/tts/lab/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  deleteLabSample: (sampleId: string) =>
    request<{ deleted: boolean }>(`/api/tts/lab/samples/${encodeURIComponent(sampleId)}`, { method: "DELETE" }),

  importEpubFile: async (file: File | { name: string; data: Uint8Array }): Promise<BookDetail> => {
    const fd = new FormData();
    if (file instanceof File) {
      fd.append("file", file, file.name);
    } else {
      const bytes = new Uint8Array(file.data);
      const blob = new Blob([bytes.buffer], { type: "application/epub+zip" });
      fd.append("file", blob, file.name);
    }
    return request<BookDetail>("/api/books/import", { method: "POST", body: fd });
  },

  getBooks: (params?: { section?: string; collection?: string; q?: string }) => {
    const sp = new URLSearchParams();
    if (params?.section) sp.set("section", params.section);
    if (params?.collection) sp.set("collection", params.collection);
    if (params?.q) sp.set("q", params.q);
    const qs = sp.toString();
    return request<BookSummary[]>(qs ? `/api/books?${qs}` : "/api/books");
  },

  getBook: (bookId: string) => request<BookDetail>(`/api/books/${encodeURIComponent(bookId)}`),

  patchBook: (bookId: string, body: { is_favorite?: boolean; collection_name?: string | null }) =>
    request<BookDetail>(`/api/books/${encodeURIComponent(bookId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteBook: (bookId: string) =>
    request<{ deleted: boolean }>(`/api/books/${encodeURIComponent(bookId)}`, { method: "DELETE" }),

  getChapter: (chapterId: string) => request<ChapterContent>(`/api/chapters/${encodeURIComponent(chapterId)}`),

  searchBook: (bookId: string, q: string) =>
    request<SearchHit[]>(`/api/books/${encodeURIComponent(bookId)}/search?q=${encodeURIComponent(q)}`),

  saveProgress: (
    bookId: string,
    payload: {
      chapter_id: string;
      chapter_index: number;
      cfi?: string | null;
      scroll_offset?: number;
      sentence_index: number;
      audio_position_sec: number;
      progress_pct: number;
      is_audio_playing?: boolean;
    }
  ) =>
    request<{ saved: boolean }>(`/api/books/${encodeURIComponent(bookId)}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  getBookmarks: (bookId: string) =>
    request<BookmarkItem[]>(`/api/books/${encodeURIComponent(bookId)}/bookmarks`),

  addBookmark: (
    bookId: string,
    body: {
      chapter_id: string;
      chapter_index: number;
      label: string;
      cfi?: string | null;
      sentence_index?: number | null;
      excerpt?: string | null;
    }
  ) =>
    request<BookmarkItem>(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteBookmark: (bookmarkId: string) =>
    request<{ deleted: boolean }>(`/api/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: "DELETE" }),

  getHighlights: (bookId: string) =>
    request<HighlightItem[]>(`/api/books/${encodeURIComponent(bookId)}/highlights`),

  addHighlight: (
    bookId: string,
    body: {
      chapter_id: string;
      chapter_index: number;
      selected_text: string;
      note?: string | null;
      color?: string;
      cfi_range?: string | null;
    }
  ) =>
    request<HighlightItem>(`/api/books/${encodeURIComponent(bookId)}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteHighlight: (highlightId: string) =>
    request<{ deleted: boolean }>(`/api/highlights/${encodeURIComponent(highlightId)}`, { method: "DELETE" }),

  generateChapterAudio: (payload: {
    chapter_id: string;
    voice_id: string;
    model_id: string;
    start_sentence_index: number;
    device?: "auto" | "cuda" | "cpu";
    pregenerate_next?: boolean;
  }) =>
    request<{
      job_id: string | null;
      status: string;
      already_cached: boolean;
      chapter_status: ChapterAudioStatus;
    }>("/api/audiobook/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  prioritizeSentence: (chapterId: string, sentenceIndex: number) =>
    request<{ ok: boolean }>("/api/audiobook/prioritize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter_id: chapterId, sentence_index: sentenceIndex }),
    }),

  getChapterAudioStatus: (chapterId: string, voiceId?: string, modelId?: string) => {
    const sp = new URLSearchParams();
    if (voiceId) sp.set("voice_id", voiceId);
    if (modelId) sp.set("model_id", modelId);
    const qs = sp.toString();
    return request<ChapterAudioStatus>(
      `/api/audiobook/chapter/${encodeURIComponent(chapterId)}/status${qs ? `?${qs}` : ""}`
    );
  },

  cancelJob: (jobId: string) =>
    request<Record<string, unknown>>(`/api/tts/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }),

  getSettings: () => request<AppSettings>("/api/settings"),

  updateSettings: (values: Record<string, unknown>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }),

  getStorageStats: () => request<StorageStats>("/api/storage/stats"),

  clearAudioCache: (bookId?: string) =>
    request<{ cleared: boolean; removed_files: number }>("/api/storage/clear-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book_id: bookId ?? null }),
    }),

  clearTempCache: () => request<{ cleared: boolean }>("/api/storage/clear-temp", { method: "POST" }),

  deleteAllData: (confirmPhrase: string) =>
    request<{ wiped: boolean }>("/api/privacy/delete-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_phrase: confirmPhrase }),
    }),
};

