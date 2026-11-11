import { BookOpen, Home, Library, Mic2, Settings, ShieldCheck, Cpu } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import type { PageId } from "../../types";

const NAV_ITEMS: { id: PageId; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "library", label: "Library", icon: Library },
  { id: "reader", label: "Reader", icon: BookOpen },
  { id: "voicelab", label: "Voice Lab", icon: Mic2 },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { page, setPage, hardware, settings, activeBook } = useAppStore();

  const activeModelShort = settings?.active_model_id?.split("/").pop() || "0.6B-Base";

  return (
    <aside className="w-60 shrink-0 bg-[#141418] border-r border-[#24242d] flex flex-col justify-between select-none">
      <div>
        <div className="px-5 pt-6 pb-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#d4a373]/15 border border-[#d4a373]/40 flex items-center justify-center text-[#d4a373] font-semibold text-base">
            NF
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-[#f1f1f4]">NovelFlow</div>
            <div className="text-[11px] text-[#8d8d9b]">Local AI Audiobook Reader</div>
          </div>
        </div>

        <nav className="px-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const disabled = item.id === "reader" && !activeBook;
            return (
              <button
                key={item.id}
                onClick={() => !disabled && setPage(item.id)}
                disabled={disabled}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-[13.5px] transition-colors ${
                  active
                    ? "bg-[#d4a373]/14 text-[#f5efe8] font-medium border border-[#d4a373]/30"
                    : disabled
                    ? "text-[#555562] cursor-not-allowed"
                    : "text-[#9d9daa] hover:text-[#ececef] hover:bg-[#1d1d24]"
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? "text-[#d4a373]" : ""}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 space-y-2.5 border-t border-[#24242d]">
        <div className="rounded-lg bg-[#1a1a20] border border-[#262630] p-3 text-[11.5px] space-y-1.5">
          <div className="flex items-center gap-1.5 text-[#d4a373] font-medium">
            <Cpu className="w-3.5 h-3.5" />
            <span className="truncate">{activeModelShort}</span>
          </div>
          <div className="text-[#8e8e9b] truncate">
            {hardware?.cuda_available
              ? `${hardware.gpu_name} (${hardware.vram_total_gb} GB)`
              : `CPU: ${hardware?.cpu_name || "Detecting..."}`}
          </div>
        </div>
        <div className="flex items-center gap-2 px-1 text-[11px] text-[#7e7e8c]">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400/80 shrink-0" />
          <span>100% Offline • Unlimited Local AI</span>
        </div>
      </div>
    </aside>
  );
}

