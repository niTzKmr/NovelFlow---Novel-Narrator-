import type { ReaderPreferences } from "../../types";

interface ReaderSettingsPopoverProps {
  prefs: ReaderPreferences;
  onChange: (patch: Partial<ReaderPreferences>) => void;
}

const FONTS = [
  { label: "Literata / Serif", value: "Literata, Georgia, Cambria, serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Inter / Sans", value: "Inter, Segoe UI, system-ui, sans-serif" },
  { label: "Palatino", value: "Palatino Linotype, Book Antiqua, Palatino, serif" },
];

const THEMES: { id: ReaderPreferences["theme"]; label: string; bg: string; fg: string }[] = [
  { id: "charcoal", label: "Charcoal", bg: "#141418", fg: "#e6e6eb" },
  { id: "dark", label: "Dark", bg: "#09090b", fg: "#e4e4e7" },
  { id: "sepia", label: "Sepia", bg: "#f3ead8", fg: "#3a2e21" },
  { id: "light", label: "Light", bg: "#faf8f4", fg: "#1c1c21" },
  { id: "custom", label: "Custom", bg: "#18181b", fg: "#d4a373" },
];

export function ReaderSettingsPopover({ prefs, onChange }: ReaderSettingsPopoverProps) {
  return (
    <div className="w-80 rounded-2xl bg-[#18181f] border border-[#2d2d39] shadow-2xl p-4 space-y-4 text-xs text-[#ececef]">
      <div>
        <div className="text-[#9898a6] mb-1.5 font-medium">Theme</div>
        <div className="grid grid-cols-5 gap-1.5">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => onChange({ theme: t.id })}
              className={`py-2 px-1 rounded-lg border text-[11px] font-medium transition ${
                prefs.theme === t.id ? "border-[#d4a373] ring-1 ring-[#d4a373]/40" : "border-[#2c2c38]"
              }`}
              style={{ backgroundColor: t.bg, color: t.fg }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {prefs.theme === "custom" && (
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <label className="flex items-center justify-between bg-[#121217] px-2.5 py-1.5 rounded-lg border border-[#282833]">
              <span>Background</span>
              <input
                type="color"
                value={prefs.custom_bg}
                onChange={(e) => onChange({ custom_bg: e.target.value })}
                className="w-6 h-5 bg-transparent border-0 cursor-pointer"
              />
            </label>
            <label className="flex items-center justify-between bg-[#121217] px-2.5 py-1.5 rounded-lg border border-[#282833]">
              <span>Text</span>
              <input
                type="color"
                value={prefs.custom_fg}
                onChange={(e) => onChange({ custom_fg: e.target.value })}
                className="w-6 h-5 bg-transparent border-0 cursor-pointer"
              />
            </label>
          </div>
        )}
      </div>

      <div>
        <div className="text-[#9898a6] mb-1.5 font-medium">Font Family</div>
        <select
          value={prefs.font_family}
          onChange={(e) => onChange({ font_family: e.target.value })}
          className="w-full bg-[#121217] border border-[#2c2c38] rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-[#d4a373]"
        >
          {FONTS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2.5">
        <div>
          <div className="flex justify-between text-[#9898a6] mb-1">
            <span>Font Size</span>
            <span className="tabular-nums text-[#ececef]">{prefs.font_size}px</span>
          </div>
          <input
            type="range"
            min={14}
            max={30}
            step={1}
            value={prefs.font_size}
            onChange={(e) => onChange({ font_size: Number(e.target.value) })}
            className="w-full accent-[#d4a373]"
          />
        </div>
        <div>
          <div className="flex justify-between text-[#9898a6] mb-1">
            <span>Line Height</span>
            <span className="tabular-nums text-[#ececef]">{prefs.line_height.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={1.3}
            max={2.2}
            step={0.05}
            value={prefs.line_height}
            onChange={(e) => onChange({ line_height: Number(e.target.value) })}
            className="w-full accent-[#d4a373]"
          />
        </div>
        <div>
          <div className="flex justify-between text-[#9898a6] mb-1">
            <span>Paragraph Spacing</span>
            <span className="tabular-nums text-[#ececef]">{prefs.paragraph_spacing}px</span>
          </div>
          <input
            type="range"
            min={6}
            max={32}
            step={2}
            value={prefs.paragraph_spacing}
            onChange={(e) => onChange({ paragraph_spacing: Number(e.target.value) })}
            className="w-full accent-[#d4a373]"
          />
        </div>
        <div>
          <div className="flex justify-between text-[#9898a6] mb-1">
            <span>Reading Width</span>
            <span className="tabular-nums text-[#ececef]">{prefs.reading_width}px</span>
          </div>
          <input
            type="range"
            min={520}
            max={1040}
            step={20}
            value={prefs.reading_width}
            onChange={(e) => onChange({ reading_width: Number(e.target.value) })}
            className="w-full accent-[#d4a373]"
          />
        </div>
      </div>

      <label className="flex items-center justify-between pt-2 border-t border-[#272732] cursor-pointer">
        <span>Auto-continue next chapter</span>
        <input
          type="checkbox"
          checked={prefs.auto_continue_chapter}
          onChange={(e) => onChange({ auto_continue_chapter: e.target.checked })}
          className="accent-[#d4a373]"
        />
      </label>
    </div>
  );
}

