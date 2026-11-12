import { useEffect, useState } from "react";
import { Download, CheckCircle2, Cpu, AlertTriangle, X } from "lucide-react";
import { api } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";

export function FirstRunWizard() {
  const { showFirstRunWizard, dismissWizard, models, hardware, refreshModelsAndVoices } = useAppStore();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");

  useEffect(() => {
    if (!downloadingId) return;
    const t = window.setInterval(async () => {
      try {
        const st = await api.getDownloadStatus(downloadingId);
        if (st.status === "completed") {
          setDownloadingId(null);
          setStatusMsg("Model downloaded and verified locally!");
          await refreshModelsAndVoices();
        } else if (st.status === "failed") {
          setDownloadingId(null);
          setStatusMsg(`Download failed: ${st.error || "Check network connection"}`);
        }
      } catch {
        // ignore transient poll error
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [downloadingId, refreshModelsAndVoices]);

  if (!showFirstRunWizard) return null;

  const startDownload = async (modelId: string) => {
    setDownloadingId(modelId);
    setStatusMsg(`Downloading ${modelId.split("/").pop()} locally (only required once)...`);
    try {
      await api.downloadModel(modelId);
    } catch (err) {
      setDownloadingId(null);
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-2xl bg-[#13151c] border border-[#2c2c36] rounded-2xl p-6 shadow-2xl space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-[#f3f3f6]">Welcome to NovelFlow</h2>
            <p className="text-sm text-[#9898a6] mt-1">
              Download a local Qwen3-TTS voice model once to unlock unlimited offline narration with zero cloud APIs or subscriptions.
            </p>
          </div>
          <button
            onClick={dismissWizard}
            className="p-1.5 rounded-lg text-[#8d8d9b] hover:text-white hover:bg-[#24242d]"
            title="Skip for now"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="rounded-xl bg-[#181b24] border border-[#2a2a35] p-3.5 text-xs text-[#b4b4c0] flex items-center gap-3">
          <Cpu className="w-4 h-4 text-[#e5a95e] shrink-0" />
          <span>
            Detected: <strong>{hardware?.gpu_name || hardware?.cpu_name}</strong>{" "}
            {hardware?.cuda_available ? `(${hardware.vram_total_gb} GB VRAM)` : "(CPU mode)"} • RAM: {hardware?.ram_total_gb} GB • Free Disk: {hardware?.disk_free_gb} GB
          </span>
        </div>

        <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
          {models.map((m) => (
            <div
              key={m.model_id}
              className="rounded-xl bg-[#191c26] border border-[#2a2a34] p-3.5 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#f1f1f4] truncate">{m.display_name}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-[#9898a6]">
                    {m.disk_size_gb} GB • {m.license}
                  </span>
                </div>
                {m.compatibility.warning && (
                  <div className="text-[11.5px] text-amber-300/90 mt-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{m.compatibility.warning}</span>
                  </div>
                )}
              </div>
              {m.is_downloaded ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400 font-medium shrink-0">
                  <CheckCircle2 className="w-4 h-4" /> Ready
                </span>
              ) : (
                <button
                  onClick={() => startDownload(m.model_id)}
                  disabled={downloadingId !== null}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#e5a95e] text-[#141210] text-xs font-semibold hover:brightness-105 disabled:opacity-50 shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  {downloadingId === m.model_id ? "Downloading..." : "Download"}
                </button>
              )}
            </div>
          ))}
        </div>

        {statusMsg && <div className="text-xs text-[#e5a95e]">{statusMsg}</div>}

        <div className="flex justify-end gap-3 pt-2 border-t border-[#262630]">
          <button
            onClick={dismissWizard}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-[#24242d] text-[#ececef] hover:bg-[#2d2d38]"
          >
            Continue to NovelFlow
          </button>
        </div>
      </div>
    </div>
  );
}

