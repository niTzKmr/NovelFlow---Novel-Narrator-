import { BookOpen, Cpu, Home, Library, Mic2, Settings, ShieldCheck } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import type { PageId } from "../../types";
import { NovelFlowLogo } from "../brand/NovelFlowLogo";

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
    <aside className="w-60 shrink-0 bg-[#101218] border-r border-[#212533] flex flex-col justify-between select-none">
      <div>
        <div className="px-5 pt-5 pb-5 flex items-center gap-3">
          <NovelFlowLogo size={38} className="shrink-0" />
          <div>
            <div className="text-[15.5px] font-semibold tracking-tight text-[#f5f5f7]">NovelFlow</div>
            <div className="text-[11px] text-[#848b9f]">Local AI Novel Reader</div>
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
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[13.5px] transition-all ${
                  active
                    ? "bg-[#e5a95e]/14 text-[#f6f3ee] font-medium border border-[#e5a95e]/35 shadow-sm"
                    : disabled
                    ? "text-[#4e5365] cursor-not-allowed"
                    : "text-[#9ca3b6] hover:text-[#f4f5f8] hover:bg-[#191c26]"
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? "text-[#e5a95e]" : ""}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 space-y-2.5 border-t border-[#212533]">
        <div className="rounded-xl bg-[#161922] border border-[#252a38] p-3 text-[11.5px] space-y-1.5">
          <div className="flex items-center gap-1.5 text-[#e5a95e] font-medium">
            <Cpu className={`w-3.5 h-3.5 ${hardware?.cuda_available ? "text-[#818cf8]" : "text-[#e5a95e]"}`} />
            <span className="truncate">{activeModelShort}</span>
          </div>
          <div className="text-[#8e95aa] truncate">
            {hardware?.cuda_available
              ? `${hardware.gpu_name} (${hardware.vram_total_gb} GB)`
              : `CPU: ${hardware?.cpu_name || "Detecting..."}`}
          </div>
        </div>
        <div className="flex items-center gap-2 px-1 text-[11px] text-[#7c8398]">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>100% Offline • Unlimited Local AI</span>
        </div>
      </div>
    </aside>
  );
}
