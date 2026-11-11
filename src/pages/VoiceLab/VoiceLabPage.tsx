import { AlertTriangle, Check, Download, Mic2, Play, RotateCcw, Sparkles, Star, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, resolveBackendUrl } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";
import type { LabSample } from "../../types";

export function VoiceLabPage() {
  const { models, voices, hardware, settings, refreshModelsAndVoices, updateAppSettings, setErrorToast } =
    useAppStore();

  const [selectedModelId, setSelectedModelId] = useState(
    settings?.active_model_id || "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
  );
  const [device, setDevice] = useState<"auto" | "cuda" | "cpu">(settings?.device_preference || "auto");
  const [selectedVoiceId, setSelectedVoiceId] = useState(
    settings?.preferred_voice_id || "narrator-deep-cinematic"
  );
  const [fixedScript, setFixedScript] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [instructText, setInstructText] = useState("");
  const [samples, setSamples] = useState<LabSample[]>([]);
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Ready for offline Qwen3-TTS auditioning.");
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  // Design / Clone tabs
  const [studioTab, setStudioTab] = useState<"design" | "clone">("design");
  const [designName, setDesignName] = useState("");
  const [designDesc, setDesignDesc] = useState("");
  const [designInstruct, setDesignInstruct] = useState("");
  const [creatingDesign, setCreatingDesign] = useState(false);

  const [cloneName, setCloneName] = useState("");
  const [cloneTranscript, setCloneTranscript] = useState("");
  const [cloneConsent, setCloneConsent] = useState(false);
  const [cloneFile, setCloneFile] = useState<File | { name: string; data: Uint8Array } | null>(null);
  const [creatingClone, setCreatingClone] = useState(false);

  useEffect(() => {
    Promise.all([api.getLabMeta(), api.getLabSamples()])
      .then(([meta, smp]) => {
        setFixedScript(meta.fixed_sample_script);
        setScriptText((prev) => prev || meta.fixed_sample_script);
        setSamples(smp);
      })
      .catch(() => {});
  }, []);

  const selectedModel = useMemo(
    () => models.find((m) => m.model_id === selectedModelId) || models[0],
    [models, selectedModelId]
  );

  const compatibleVoices = useMemo(
    () => voices.filter((v) => v.compatible_models.includes(selectedModelId)),
    [voices, selectedModelId]
  );

  useEffect(() => {
    if (compatibleVoices.length > 0 && !compatibleVoices.some((v) => v.voice_id === selectedVoiceId)) {
      setSelectedVoiceId(compatibleVoices[0].voice_id);
    }
  }, [compatibleVoices, selectedVoiceId]);

  const activeVoice = useMemo(
    () => compatibleVoices.find((v) => v.voice_id === selectedVoiceId),
    [compatibleVoices, selectedVoiceId]
  );

  useEffect(() => {
    if (activeVoice?.instruct_prompt) {
      setInstructText(activeVoice.instruct_prompt);
    }
  }, [activeVoice]);

  const handleGenerate = async () => {
    if (!activeVoice || !selectedModel) return;
    setGenerating(true);
    setStatusMsg("Synthesizing locally on Qwen3-TTS...");
    try {
      const out = await api.generateLabSample({
        voice_id: activeVoice.voice_id,
        model_id: selectedModel.model_id,
        text: scriptText,
        instruct: selectedModel.supports_instruct ? instructText : null,
        device,
      });
      setStatusMsg(
        `Generated ${out.audio_duration_sec}s in ${out.generation_sec}s (${out.rtf}x RTF, ${out.peak_vram_mb} MB VRAM) on ${out.device_used}.`
      );
      const latest = await api.getLabSamples();
      setSamples(latest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`Failed: ${msg}`);
      setErrorToast(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handlePreferVoice = async () => {
    if (!activeVoice) return;
    await api.preferVoice(activeVoice.voice_id);
    await updateAppSettings({
      preferred_voice_id: activeVoice.voice_id,
      active_model_id: selectedModelId,
    });
    await refreshModelsAndVoices();
    setStatusMsg(`Saved "${activeVoice.name}" as your active audiobook narrator.`);
  };

  const handleDeleteVoice = async () => {
    if (!activeVoice || activeVoice.is_builtin) return;
    await api.deleteVoice(activeVoice.voice_id);
    await refreshModelsAndVoices();
  };

  const handleDesignVoice = async () => {
    setCreatingDesign(true);
    try {
      const res = await api.designVoice({
        name: designName,
        description: designDesc,
        instruct: designInstruct,
        device,
      });
      await refreshModelsAndVoices();
      setSelectedVoiceId(res.profile.voice_id);
      setDesignName("");
      setDesignDesc("");
      setDesignInstruct("");
      setStatusMsg(`Created reusable narrator "${res.profile.name}".`);
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDesign(false);
    }
  };

  const handlePickCloneAudio = async () => {
    if (window.novelflow) {
      const picked = await window.novelflow.openAudioFile();
      if (picked) setCloneFile(picked);
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".wav,.mp3,.flac,.ogg,.m4a";
      input.onchange = () => {
        if (input.files?.[0]) setCloneFile(input.files[0]);
      };
      input.click();
    }
  };

  const handleCloneVoice = async () => {
    if (!cloneFile) return;
    setCreatingClone(true);
    try {
      const fd = new FormData();
      fd.append("name", cloneName);
      fd.append("description", "Authorized local cloned voice");
      fd.append("ref_text", cloneTranscript);
      fd.append("consent_confirmed", cloneConsent ? "true" : "false");
      if (cloneFile instanceof File) {
        fd.append("audio_file", cloneFile, cloneFile.name);
      } else {
        const bytes = new Uint8Array(cloneFile.data);
        fd.append("audio_file", new Blob([bytes.buffer]), cloneFile.name);
      }
      const profile = await api.cloneVoice(fd);
      await refreshModelsAndVoices();
      setSelectedModelId("Qwen/Qwen3-TTS-12Hz-0.6B-Base");
      setSelectedVoiceId(profile.voice_id);
      setCloneName("");
      setCloneTranscript("");
      setCloneConsent(false);
      setCloneFile(null);
      setStatusMsg(`Saved cloned voice "${profile.name}".`);
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingClone(false);
    }
  };

  return (
    <div className="p-7 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f4f4f7]">Voice Testing Lab</h1>
          <p className="text-sm text-[#8e8e9c] mt-0.5">
            Audition narrators locally, compare speed and VRAM telemetry, design new voices, or clone authorized audio.
          </p>
        </div>
        <div className="px-3.5 py-2 rounded-xl bg-[#16161b] border border-[#262630] text-xs text-[#9c9caa]">
          {hardware?.cuda_available
            ? `GPU: ${hardware.gpu_name} (${hardware.vram_total_gb} GB VRAM)`
            : `CPU: ${hardware?.cpu_name || "Detecting..."}`}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-5">
          {/* Model & Compatibility Card */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#8d8d9b] mb-1.5">Active Qwen3-TTS Checkpoint</label>
                <select
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                  className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#d4a373]"
                >
                  {models.map((m) => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.display_name} {m.is_downloaded ? "✓ Local" : "(Not Downloaded)"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8d8d9b] mb-1.5">Compute Device</label>
                <select
                  value={device}
                  onChange={(e) => setDevice(e.target.value as "auto" | "cuda" | "cpu")}
                  className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#d4a373]"
                >
                  <option value="auto">Auto (Recommended)</option>
                  <option value="cuda">CUDA GPU (bfloat16)</option>
                  <option value="cpu">CPU Fallback (float32)</option>
                </select>
              </div>
            </div>

            {selectedModel && (
              <div className="space-y-2 text-xs">
                <div className="rounded-xl bg-[#1c1c23] border border-[#292934] px-3.5 py-2.5 flex items-center justify-between gap-3">
                  <div className="text-[#b8b8c6]">
                    <strong className="text-[#f1f1f4]">{selectedModel.short_name}</strong> •{" "}
                    {selectedModel.license} •{" "}
                    {selectedModel.supports_instruct ? "Style Instructions Supported" : "No Runtime Instruct"}
                  </div>
                  {!selectedModel.is_downloaded && (
                    <button
                      onClick={() => api.downloadModel(selectedModel.model_id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#d4a373] text-[#141210] font-semibold"
                    >
                      <Download className="w-3 h-3" /> Download
                    </button>
                  )}
                </div>

                {selectedModel.compatibility.warning && (
                  <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 px-3.5 py-2.5 text-amber-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{selectedModel.compatibility.warning}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Voice Selection + Script + Generate */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#f1f1f4]">Compatible Voices</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePreferVoice}
                  disabled={!activeVoice}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21212a] border border-[#2f2f3c] text-xs text-[#ececef] hover:border-[#d4a373]/50"
                >
                  <Star className={`w-3.5 h-3.5 ${activeVoice?.is_preferred ? "fill-[#d4a373] text-[#d4a373]" : ""}`} />
                  {activeVoice?.is_preferred ? "Active Narrator" : "Use as Narrator"}
                </button>
                <button
                  onClick={handleDeleteVoice}
                  disabled={!activeVoice || activeVoice.is_builtin}
                  className="p-1.5 rounded-lg bg-[#21212a] text-[#8d8d9b] hover:text-red-400 disabled:opacity-35"
                  title="Delete custom profile"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {compatibleVoices.map((v) => {
                const selected = v.voice_id === selectedVoiceId;
                return (
                  <button
                    key={v.voice_id}
                    onClick={() => setSelectedVoiceId(v.voice_id)}
                    className={`w-full text-left p-3 rounded-xl border transition ${
                      selected
                        ? "bg-[#d4a373]/14 border-[#d4a373]/55"
                        : "bg-[#1c1c23] border-[#282833] hover:border-[#373746]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#f1f1f4]">{v.name}</span>
                      <div className="flex items-center gap-1.5">
                        {v.is_preferred && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#d4a373]/20 text-[#d4a373] font-medium">
                            Preferred
                          </span>
                        )}
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-[#9898a6]">
                          {v.kind === "designed_narrator" ? "Narrator" : v.kind}
                        </span>
                      </div>
                    </div>
                    <p className="text-[11.5px] text-[#9595a3] mt-1">{v.description}</p>
                  </button>
                );
              })}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-[#8d8d9b]">Sample Audition Script</label>
                <button
                  onClick={() => setScriptText(fixedScript)}
                  className="inline-flex items-center gap-1 text-[11px] text-[#d4a373] hover:underline"
                >
                  <RotateCcw className="w-3 h-3" /> Reset Fixed Script
                </button>
              </div>
              <textarea
                rows={3}
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                className="w-full bg-[#1d1d24] border border-[#2c2c38] rounded-xl px-3.5 py-2.5 text-sm font-serif text-[#f1f1f4] outline-none focus:border-[#d4a373]"
              />
            </div>

            {selectedModel?.supports_instruct && (
              <div>
                <label className="block text-xs text-[#8d8d9b] mb-1.5">
                  Narration Instruction (Supported by {selectedModel.short_name})
                </label>
                <textarea
                  rows={2}
                  value={instructText}
                  onChange={(e) => setInstructText(e.target.value)}
                  className="w-full bg-[#1d1d24] border border-[#2c2c38] rounded-xl px-3 py-2 text-xs text-[#ececef] outline-none focus:border-[#d4a373]"
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-4 pt-1">
              <span className="text-xs text-[#9595a3]">{statusMsg}</span>
              <button
                onClick={handleGenerate}
                disabled={generating || !activeVoice}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105 disabled:opacity-50 shrink-0"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {generating ? "Synthesizing..." : "Generate Sample"}
              </button>
            </div>
          </div>

          {/* Voice Design & Cloning Studio */}
          <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-[#24242f] pb-3">
              <button
                onClick={() => setStudioTab("design")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
                  studioTab === "design" ? "bg-[#24242e] text-white" : "text-[#8d8d9b] hover:text-white"
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-[#d4a373]" />
                Voice Design (Text Prompt)
              </button>
              <button
                onClick={() => setStudioTab("clone")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
                  studioTab === "clone" ? "bg-[#24242e] text-white" : "text-[#8d8d9b] hover:text-white"
                }`}
              >
                <Mic2 className="w-3.5 h-3.5 text-[#d4a373]" />
                Voice Cloning (Authorized Audio)
              </button>
            </div>

            {studioTab === "design" ? (
              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={designName}
                    onChange={(e) => setDesignName(e.target.value)}
                    placeholder="Profile name (e.g., Midnight Narrator)"
                    className="bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white outline-none focus:border-[#d4a373]"
                  />
                  <input
                    type="text"
                    value={designDesc}
                    onChange={(e) => setDesignDesc(e.target.value)}
                    placeholder="Short description"
                    className="bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white outline-none focus:border-[#d4a373]"
                  />
                </div>
                <textarea
                  rows={3}
                  value={designInstruct}
                  onChange={(e) => setDesignInstruct(e.target.value)}
                  placeholder="Describe voice timbre, age, accent, breathing, pacing, and clean studio recording quality..."
                  className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white outline-none focus:border-[#d4a373]"
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleDesignVoice}
                    disabled={creatingDesign || !designName.trim() || !designInstruct.trim()}
                    className="px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] font-semibold disabled:opacity-45"
                  >
                    {creatingDesign ? "Designing..." : "Design & Save Profile"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap gap-3 items-center">
                  <input
                    type="text"
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder="Cloned voice name"
                    className="flex-1 bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white outline-none focus:border-[#d4a373]"
                  />
                  <button
                    onClick={handlePickCloneAudio}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#22222c] border border-[#30303d] text-[#ececef]"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {cloneFile ? cloneFile.name : "Choose Audio (WAV/MP3)"}
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={cloneTranscript}
                  onChange={(e) => setCloneTranscript(e.target.value)}
                  placeholder="Exact transcript spoken in the reference recording..."
                  className="w-full bg-[#1e1e26] border border-[#2c2c38] rounded-xl px-3 py-2 text-white outline-none focus:border-[#d4a373]"
                />
                <label className="flex items-start gap-2 text-[#a0a0ae] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cloneConsent}
                    onChange={(e) => setCloneConsent(e.target.checked)}
                    className="mt-0.5 accent-[#d4a373]"
                  />
                  <span>
                    I confirm I own or have explicit permission to use this speaker's voice recording for local offline narration.
                  </span>
                </label>
                <div className="flex justify-end">
                  <button
                    onClick={handleCloneVoice}
                    disabled={creatingClone || !cloneFile || !cloneName.trim() || !cloneTranscript.trim() || !cloneConsent}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] font-semibold disabled:opacity-45"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {creatingClone ? "Saving..." : "Save Cloned Profile"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Side-by-side Audition Rack */}
        <div className="lg:col-span-5 rounded-2xl bg-[#16161b] border border-[#25252f] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#f1f1f4]">Comparison Rack</h2>
            <select
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
              className="bg-[#1e1e26] border border-[#2c2c38] rounded-lg px-2 py-1 text-xs text-[#ececef]"
            >
              {[0.75, 1.0, 1.25, 1.5].map((sp) => (
                <option key={sp} value={sp}>
                  {sp}x
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-3 max-h-[680px] overflow-y-auto pr-1">
            {samples.length === 0 ? (
              <div className="text-xs text-[#888896] p-4 rounded-xl bg-[#1c1c23]">
                No audition samples yet. Select a narrator and click Generate Sample.
              </div>
            ) : (
              samples.map((s) => (
                <div key={s.sample_id} className="rounded-xl bg-[#1c1c23] border border-[#282834] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#f1f1f4]">{s.voice_name}</span>
                    <button
                      onClick={async () => {
                        await api.deleteLabSample(s.sample_id);
                        setSamples((prev) => prev.filter((x) => x.sample_id !== s.sample_id));
                      }}
                      className="text-[11px] text-[#8d8d9b] hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[10.5px] text-[#9b9ba8]">
                    <span className="px-2 py-0.5 rounded bg-black/30">{s.model_id.split("/").pop()}</span>
                    <span className="px-2 py-0.5 rounded bg-black/30">{s.device_used}</span>
                    <span className="px-2 py-0.5 rounded bg-black/30">{s.audio_duration_sec}s</span>
                    <span className="px-2 py-0.5 rounded bg-black/30">{s.generation_sec}s ({s.rtf}x RTF)</span>
                    <span className="px-2 py-0.5 rounded bg-black/30">{s.peak_vram_mb} MB VRAM</span>
                  </div>
                  <audio
                    controls
                    src={resolveBackendUrl(s.audio_url)}
                    onPlay={(e) => {
                      e.currentTarget.playbackRate = playbackSpeed;
                    }}
                    className="w-full h-9"
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

