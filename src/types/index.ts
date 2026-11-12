export type PageId = "home" | "library" | "reader" | "voicelab" | "settings";

export interface ModelCompatibility {
  fits_dedicated_vram: boolean;
  recommended_device: "cuda" | "cpu";
  recommended_dtype: "bfloat16" | "float32";
  recommended_batch_size: number;
  warning: string | null;
  can_run_cpu_fallback: boolean;
}

export interface ModelInfo {
  model_id: string;
  short_name: string;
  display_name: string;
  parameter_tier: "0.6B" | "1.7B";
  architecture_mode: "base" | "custom_voice" | "voice_design";
  disk_size_gb: number;
  min_vram_gb: number;
  recommended_vram_gb: number;
  license: string;
  supports_preset_speakers: boolean;
  supports_instruct: boolean;
  supports_voice_design: boolean;
  supports_voice_clone: boolean;
  is_downloaded: boolean;
  local_path: string;
  is_active: boolean;
  active_device: string | null;
  active_dtype: string | null;
  compatibility: ModelCompatibility;
}

export interface HardwareStatus {
  os_name: string;
  os_version: string;
  cpu_name: string;
  cpu_cores_physical: number;
  cpu_cores_logical: number;
  ram_total_gb: number;
  ram_available_gb: number;
  cuda_available: boolean;
  gpu_name: string | null;
  vram_total_gb: number;
  vram_free_gb: number;
  bf16_supported: boolean;
  disk_free_gb: number;
  ffmpeg_available: boolean;
  ffmpeg_path: string | null;
}

export interface VoiceProfile {
  voice_id: string;
  name: string;
  kind: "preset" | "designed_narrator" | "cloned";
  description: string;
  narrator_style: string | null;
  instruct_prompt: string | null;
  speaker_name: string | null;
  ref_audio_path: string | null;
  ref_text: string | null;
  prompt_cache_path: string | null;
  sample_audio_url: string | null;
  compatible_models: string[];
  is_builtin: boolean;
  is_preferred: boolean;
  consent_confirmed: boolean;
  created_at: string;
}

export interface LabSample {
  sample_id: string;
  voice_id: string;
  voice_name: string;
  model_id: string;
  device_used: string;
  dtype_used: string;
  text: string;
  instruct: string | null;
  audio_url: string;
  audio_duration_sec: number;
  generation_sec: number;
  load_sec: number;
  rtf: number;
  peak_vram_mb: number;
  ram_mb: number;
  sample_rate: number;
  created_at?: string;
  warning?: string | null;
}

export interface BookSummary {
  book_id: string;
  title: string;
  author: string;
  language: string;
  description: string;
  publisher: string;
  cover_url: string | null;
  epub_url: string;
  total_chapters: number;
  total_words: number;
  is_favorite: boolean;
  collection_name: string | null;
  reading_progress_pct: number;
  listening_progress_pct: number;
  added_at: string;
  last_opened_at: string | null;
  last_played_at: string | null;
}

export interface ChapterMeta {
  chapter_id: string;
  chapter_index: number;
  href: string;
  title: string;
  word_count: number;
  char_count: number;
  text_hash: string;
}

export interface ReadingPosition {
  chapter_id: string;
  chapter_index: number;
  cfi: string | null;
  scroll_offset: number;
  sentence_index: number;
  audio_position_sec: number;
  progress_pct: number;
  updated_at: string;
}

export interface BookDetail extends BookSummary {
  chapters: ChapterMeta[];
  position: ReadingPosition | null;
}

export interface SentenceItem {
  sentence_index: number;
  paragraph_index: number;
  text: string;
}

export interface ChapterContent {
  chapter_id: string;
  book_id: string;
  chapter_index: number;
  href: string;
  title: string;
  html: string;
  sentences: SentenceItem[];
  word_count: number;
  char_count: number;
  text_hash: string;
}

export interface BookmarkItem {
  bookmark_id: string;
  book_id: string;
  chapter_id: string;
  chapter_index: number;
  cfi: string | null;
  sentence_index: number | null;
  label: string;
  excerpt: string | null;
  created_at: string;
}

export interface HighlightItem {
  highlight_id: string;
  book_id: string;
  chapter_id: string;
  chapter_index: number;
  cfi_range: string | null;
  selected_text: string;
  note: string | null;
  color: string;
  created_at: string;
}

export interface SearchHit {
  chapter_id: string;
  chapter_index: number;
  chapter_title: string;
  sentence_index: number;
  paragraph_index: number;
  snippet: string;
}

export interface SentenceTiming {
  sentence_index: number;
  paragraph_index: number;
  start_sec: number;
  end_sec: number;
}

export interface AudioChunkStatus {
  chunk_index: number;
  chunk_key: string;
  sentence_start: number;
  sentence_end: number;
  status: "cached" | "pending";
  audio_url: string | null;
  duration_sec: number | null;
  sentence_timings: SentenceTiming[];
}

export interface ChapterAudioStatus {
  book_id: string;
  chapter_id: string;
  voice_id: string;
  model_id: string;
  format: string;
  total_chunks: number;
  cached_chunks: number;
  complete: boolean;
  total_cached_duration_sec: number;
  chunks: AudioChunkStatus[];
}

export interface ReaderPreferences {
  font_family: string;
  font_size: number;
  line_height: number;
  paragraph_spacing: number;
  reading_width: number;
  theme: "charcoal" | "dark" | "light" | "sepia" | "custom";
  custom_bg: string;
  custom_fg: string;
  auto_continue_chapter: boolean;
}

export interface AppSettings {
  theme: string;
  startup_behavior: string;
  language: string;
  active_model_id: string;
  preferred_voice_id: string;
  device_preference: "auto" | "cuda" | "cpu";
  batch_size: number;
  max_cache_gb: number;
  audio_cache_format: "wav" | "mp3" | "aac";
  pregenerate_next_chapter: boolean;
  local_only_mode: boolean;
  telemetry_enabled: boolean;
  reader: ReaderPreferences;
}

export interface StorageStats {
  books_location: string;
  audio_location: string;
  voices_location: string;
  models_location: string;
  book_count: number;
  cached_chunk_count: number;
  books_mb: number;
  audio_cache_mb: number;
  voices_mb: number;
  temp_cache_mb: number;
  models_gb: number;
}

export interface SelectedBinaryFile {
  name: string;
  path: string;
  data: Uint8Array;
}

declare global {
  interface Window {
    novelflow?: {
      openEpubFiles: () => Promise<SelectedBinaryFile[]>;
      openAudioFile: () => Promise<SelectedBinaryFile | null>;
      toggleFullscreen: () => Promise<boolean>;
      setFullscreen: (flag: boolean) => Promise<boolean>;
      getAppInfo: () => Promise<{
        appVersion: string;
        isPackaged: boolean;
        backendUrl: string;
        platform: string;
      }>;
    };
  }
}

