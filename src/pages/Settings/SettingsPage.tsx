import { AudioLines, Cpu, Download, HardDrive, Loader2, Mic2, Shield, Sliders, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";
import { useTtsStudioStore } from "../../store/useTtsStudioStore";
import type { StorageStats } from "../../types";

export function SettingsPage() {
  const { settings, models, voices, hardware, updateAppSettings, updateReaderPrefs, refreshBooks, refreshModelsAndVoices, setErrorToast } =
    useAppStore();
  const { enabled: studioEnabled, setEnabledFlag: setStudioEnabled } = useTtsStudioStore();

  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [msg, setMsg] = useState("");
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);

  const loadStorage = async () => {
    try {
      const s = await api.getStorageStats();
      setStorage(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadStorage();
  }, []);

  useEffect(() => {
    if (!downloadingModelId) return;
    const t = window.setInterval(async () => {
      try {
        const st = await api.getDownloadStatus(downloadingModelId);
        if (st.status === "completed") {
          setDownloadingModelId(null);
          setMsg("Voice model downloaded and ready!");
          await refreshModelsAndVoices();
          await loadStorage();
        } else if (st.status === "failed") {
          const err = st.error || "Model download failed";
          setDownloadingModelId(null);
          setErrorToast(err);
        }
      } catch {
        // ignore transient poll error
      }
    }, 1500);
    return () => window.clearInterval(t);
  }, [downloadingModelId, refreshModelsAndVoices, setErrorToast]);

  if (!settings) return null;

  const clonedVoices = voices.filter((v) => v.kind === "cloned");

  return (
    <div className="p-7 max-w-4xl mx-auto space-y-6 pb-16">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f4f4f7]">Settings</h1>
          <p className="text-sm text-[#8e8e9c] mt-0.5">Configure local AI inference, voice defaults, storage cache, and privacy.</p>
        </div>
        {msg && <span className="text-xs text-[#d4a373] font-medium">{msg}</span>}
      </div>

      {/* GENERAL */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
          <Sliders className="w-4 h-4 text-[#d4a373]" />
          <span>General</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Default Reader Theme</label>
            <select
              value={settings.reader.theme}
              onChange={(e) => updateReaderPrefs({ theme: e.target.value as typeof settings.reader.theme })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value="charcoal">Warm Charcoal</option>
              <option value="dark">Pure Dark</option>
              <option value="sepia">Sepia</option>
              <option value="light">Light Paper</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Startup Screen</label>
            <select
              value={settings.startup_behavior}
              onChange={(e) => updateAppSettings({ startup_behavior: e.target.value })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value="home">Home Dashboard</option>
              <option value="library">Book Library</option>
            </select>
          </div>
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Primary Narration Language</label>
            <select
              value={settings.language}
              onChange={(e) => updateAppSettings({ language: e.target.value })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value="English">English</option>
              <option value="Auto">Auto Multilingual</option>
            </select>
          </div>
        </div>
      </section>

      {/* AI VOICE */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
          <Mic2 className="w-4 h-4 text-[#d4a373]" />
          <span>AI Voice</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Active Local TTS Checkpoint</label>
            <select
              value={settings.active_model_id}
              onChange={(e) => updateAppSettings({ active_model_id: e.target.value })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              {models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.display_name} {m.is_downloaded ? "✓" : "(Not downloaded)"}
                </option>
              ))}
            </select>
            {(() => {
              const curModel = models.find((m) => m.model_id === settings.active_model_id);
              if (!curModel || curModel.is_downloaded) return null;
              const isBusy = downloadingModelId === curModel.model_id;
              return (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-amber-500/10 border border-amber-400/30 px-3 py-2 text-[11.5px] text-amber-200">
                  <span>Selected checkpoint is not downloaded yet ({curModel.disk_size_gb} GB).</span>
                  <button
                    disabled={downloadingModelId !== null}
                    onClick={async () => {
                      setDownloadingModelId(curModel.model_id);
                      setMsg(`Downloading ${curModel.short_name}...`);
                      try {
                        const res = await api.downloadModel(curModel.model_id);
                        if (res.status === "completed") {
                          setDownloadingModelId(null);
                          setMsg("Voice model downloaded and ready!");
                          await refreshModelsAndVoices();
                        }
                      } catch (err) {
                        setDownloadingModelId(null);
                        setErrorToast(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#d4a373] text-[#141210] font-semibold shrink-0 disabled:opacity-60"
                  >
                    {isBusy ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" /> Downloading...
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3" /> Download
                      </>
                    )}
                  </button>
                </div>
              );
            })()}
          </div>
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Default Narrator Profile</label>
            <select
              value={settings.preferred_voice_id}
              onChange={async (e) => {
                await api.preferVoice(e.target.value);
                await updateAppSettings({ preferred_voice_id: e.target.value });
                await refreshModelsAndVoices();
              }}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name} ({v.kind})
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* PERFORMANCE */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
          <Cpu className="w-4 h-4 text-[#d4a373]" />
          <span>Performance & Hardware</span>
        </div>
        <div className="text-xs text-[#9b9ba8] bg-[#1c1c23] border border-[#282834] rounded-xl p-3">
          {hardware?.cuda_available
            ? `Detected ${hardware.gpu_name} (${hardware.vram_total_gb} GB VRAM, ${hardware.vram_free_gb} GB free, bf16=${hardware.bf16_supported}) • ${hardware.ram_total_gb} GB System RAM`
            : `CPU Mode: ${hardware?.cpu_name} • ${hardware?.ram_total_gb} GB RAM`}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Execution Device</label>
            <select
              value={settings.device_preference}
              onChange={(e) => updateAppSettings({ device_preference: e.target.value })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value="auto">Auto (VRAM Guarded)</option>
              <option value="cuda">Force CUDA GPU</option>
              <option value="cpu">Force CPU Fallback</option>
            </select>
          </div>
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Generation Batch Size</label>
            <select
              value={settings.batch_size}
              onChange={(e) => updateAppSettings({ batch_size: Number(e.target.value) })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value={1}>1 sentence (4 GB VRAM Safe)</option>
              <option value={2}>2 sentences (~3.5 GB VRAM)</option>
              <option value={4}>4 sentences (8 GB+ VRAM)</option>
            </select>
          </div>
          <div>
            <label className="block text-[#8d8d9b] mb-1.5">Audio Cache Format</label>
            <select
              value={settings.audio_cache_format}
              onChange={(e) => updateAppSettings({ audio_cache_format: e.target.value })}
              className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
            >
              <option value="wav">Lossless WAV (Instant)</option>
              <option value="mp3">Compressed MP3 (FFmpeg)</option>
              <option value="aac">Compressed AAC (FFmpeg)</option>
            </select>
          </div>
        </div>
        <label className="flex items-center justify-between text-xs pt-1 cursor-pointer">
          <span>Pre-generate next chapter in background</span>
          <input
            type="checkbox"
            checked={settings.pregenerate_next_chapter}
            onChange={(e) => updateAppSettings({ pregenerate_next_chapter: e.target.checked })}
            className="accent-[#d4a373]"
          />
        </label>
      </section>

      {/* STORAGE */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
          <HardDrive className="w-4 h-4 text-[#d4a373]" />
          <span>Storage & Cache</span>
        </div>
        {storage && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="bg-[#1c1c23] border border-[#282834] rounded-xl p-3">
              <div className="text-[#8d8d9b]">Books ({storage.book_count})</div>
              <div className="text-sm font-semibold text-white mt-0.5">{storage.books_mb} MB</div>
            </div>
            <div className="bg-[#1c1c23] border border-[#282834] rounded-xl p-3">
              <div className="text-[#8d8d9b]">Audio Cache ({storage.cached_chunk_count})</div>
              <div className="text-sm font-semibold text-white mt-0.5">{storage.audio_cache_mb} MB</div>
            </div>
            <div className="bg-[#1c1c23] border border-[#282834] rounded-xl p-3">
              <div className="text-[#8d8d9b]">Voice Refs</div>
              <div className="text-sm font-semibold text-white mt-0.5">{storage.voices_mb} MB</div>
            </div>
            <div className="bg-[#1c1c23] border border-[#282834] rounded-xl p-3">
              <div className="text-[#8d8d9b]">Local Models</div>
              <div className="text-sm font-semibold text-white mt-0.5">{storage.models_gb} GB</div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[#8d8d9b]">Max Cache (GB):</span>
            <input
              type="number"
              min={1}
              max={200}
              value={settings.max_cache_gb}
              onChange={(e) => updateAppSettings({ max_cache_gb: Number(e.target.value) })}
              className="w-20 bg-[#1e1e26] border border-[#2c2c38] rounded-lg px-2.5 py-1 text-white"
            />
          </div>
          <button
            onClick={async () => {
              const res = await api.clearAudioCache();
              setMsg(`Removed ${res.removed_files} cached audio chunks.`);
              await loadStorage();
            }}
            className="px-3 py-1.5 rounded-xl bg-[#22222c] border border-[#2f2f3c] hover:border-[#d4a373]/50"
          >
            Clear Generated Audio Cache
          </button>
          <button
            onClick={async () => {
              await api.clearTempCache();
              setMsg("Cleared temporary cache.");
              await loadStorage();
            }}
            className="px-3 py-1.5 rounded-xl bg-[#22222c] border border-[#2f2f3c] hover:border-[#d4a373]/50"
          >
            Clear Temporary Files
          </button>
        </div>
        {storage && (
          <div className="text-[11px] text-[#7c7c8a] space-y-0.5">
            <div>Library: {storage.books_location}</div>
            <div>Audio Cache: {storage.audio_location}</div>
            <div>Models: {storage.models_location}</div>
          </div>
        )}
      </section>

      {/* PRIVACY */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#f1f1f4]">
          <Shield className="w-4 h-4 text-emerald-400" />
          <span>Privacy & Voice References</span>
        </div>
        <div className="space-y-2.5 text-xs">
          <label className="flex items-center justify-between">
            <span>Local-only mode (no cloud TTS or external API calls)</span>
            <input
              type="checkbox"
              checked={settings.local_only_mode}
              onChange={(e) => updateAppSettings({ local_only_mode: e.target.checked })}
              className="accent-[#d4a373]"
            />
          </label>
          <label className="flex items-center justify-between">
            <span>Telemetry / Analytics (disabled by default)</span>
            <input
              type="checkbox"
              checked={settings.telemetry_enabled}
              onChange={(e) => updateAppSettings({ telemetry_enabled: e.target.checked })}
              className="accent-[#d4a373]"
            />
          </label>
        </div>

        {clonedVoices.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[#24242f]">
            <div className="text-xs font-medium text-[#b5b5c3]">Imported Voice References</div>
            {clonedVoices.map((v) => (
              <div key={v.voice_id} className="flex items-center justify-between bg-[#1c1c23] px-3 py-2 rounded-lg text-xs">
                <span>{v.name}</span>
                <button
                  onClick={async () => {
                    await api.deleteVoice(v.voice_id);
                    await refreshModelsAndVoices();
                  }}
                  className="text-red-400 hover:underline inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Delete Reference
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-[#262632] flex flex-wrap items-center gap-2.5 text-xs">
          <input
            type="text"
            value={wipeConfirm}
            onChange={(e) => setWipeConfirm(e.target.value)}
            placeholder="Type DELETE ALL to wipe books & custom voices"
            className="flex-1 min-w-[240px] bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white"
          />
          <button
            onClick={async () => {
              try {
                await api.deleteAllData(wipeConfirm);
                setWipeConfirm("");
                setMsg("All local library data wiped.");
                await refreshBooks();
                await refreshModelsAndVoices();
                await loadStorage();
              } catch (err) {
                setErrorToast(err instanceof Error ? err.message : String(err));
              }
            }}
            className="px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 font-medium"
          >
            Delete All Application Data
          </button>
        </div>
      </section>

      {/* TEXT TO SPEECH STUDIO FEATURE FLAG */}
      <section className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AudioLines className="w-4 h-4 text-[#d4a373]" />
            <div>
              <div className="text-sm font-semibold text-[#f1f1f4]">Text-to-Speech Studio (Standalone)</div>
              <p className="text-xs text-[#8d8d9b] mt-0.5">
                Show Text to Speech in the sidebar to synthesize arbitrary text locally without affecting your EPUB library or audiobook cache.
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            checked={studioEnabled}
            onChange={(e) => {
              void setStudioEnabled(e.target.checked).catch((err) =>
                setErrorToast(err instanceof Error ? err.message : String(err))
              );
            }}
            className="accent-[#d4a373]"
          />
        </div>
      </section>
    </div>
  );
}

