import { Bookmark, Highlighter, List, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../services/api";
import type { BookmarkItem, ChapterMeta, HighlightItem, SearchHit } from "../../types";

interface ReaderSidebarProps {
  bookId: string;
  chapters: ChapterMeta[];
  activeChapterIndex: number;
  bookmarks: BookmarkItem[];
  highlights: HighlightItem[];
  onSelectChapter: (chapterId: string, sentenceIndex?: number) => void;
  onDeleteBookmark: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  onClose: () => void;
}

export function ReaderSidebar({
  bookId,
  chapters,
  activeChapterIndex,
  bookmarks,
  highlights,
  onSelectChapter,
  onDeleteBookmark,
  onDeleteHighlight,
  onClose,
}: ReaderSidebarProps) {
  const [tab, setTab] = useState<"chapters" | "search" | "bookmarks" | "highlights">("chapters");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await api.searchBook(bookId, query);
      setHits(res);
    } finally {
      setSearching(false);
    }
  };

  return (
    <aside className="w-80 shrink-0 bg-[#141418] border-r border-[#24242e] flex flex-col h-full select-none">
      <div className="px-4 py-3 border-b border-[#24242e] flex items-center justify-between">
        <div className="flex items-center gap-1">
          {[
            { id: "chapters" as const, icon: List, label: "Chapters" },
            { id: "search" as const, icon: Search, label: "Search" },
            { id: "bookmarks" as const, icon: Bookmark, label: "Bookmarks" },
            { id: "highlights" as const, icon: Highlighter, label: "Notes" },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`p-2 rounded-lg text-xs flex items-center gap-1 ${
                  tab === t.id ? "bg-[#d4a373]/18 text-[#d4a373]" : "text-[#8e8e9b] hover:text-white"
                }`}
                title={t.label}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg text-[#8e8e9b] hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "chapters" && (
          <div className="space-y-1">
            {chapters.map((ch) => (
              <button
                key={ch.chapter_id}
                onClick={() => onSelectChapter(ch.chapter_id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition ${
                  ch.chapter_index === activeChapterIndex
                    ? "bg-[#d4a373]/16 text-[#f5efe8] border border-[#d4a373]/30 font-medium"
                    : "text-[#a4a4b2] hover:bg-[#1d1d25] hover:text-white"
                }`}
              >
                <div className="truncate">{ch.title}</div>
                <div className="text-[10.5px] text-[#757584] mt-0.5">{ch.word_count.toLocaleString()} words</div>
              </button>
            ))}
          </div>
        )}

        {tab === "search" && (
          <div className="space-y-3">
            <form onSubmit={runSearch} className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search within book..."
                className="flex-1 bg-[#1c1c23] border border-[#2b2b36] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-[#d4a373]"
              />
              <button
                type="submit"
                disabled={searching}
                className="px-3 py-1.5 rounded-lg bg-[#d4a373] text-[#141210] text-xs font-semibold"
              >
                Go
              </button>
            </form>
            <div className="space-y-2">
              {hits.map((h, i) => (
                <button
                  key={`${h.chapter_id}-${h.sentence_index}-${i}`}
                  onClick={() => onSelectChapter(h.chapter_id, h.sentence_index)}
                  className="w-full text-left p-2.5 rounded-lg bg-[#1a1a21] border border-[#262632] hover:border-[#d4a373]/40 text-xs space-y-1"
                >
                  <div className="text-[#d4a373] font-medium truncate">{h.chapter_title}</div>
                  <div className="text-[#c8c8d4] line-clamp-3 leading-relaxed">{h.snippet}</div>
                </button>
              ))}
              {!searching && hits.length === 0 && query.trim() && (
                <p className="text-xs text-[#7d7d8c] px-1">No matching passages found.</p>
              )}
            </div>
          </div>
        )}

        {tab === "bookmarks" && (
          <div className="space-y-2">
            {bookmarks.length === 0 && (
              <p className="text-xs text-[#7d7d8c] px-1">No bookmarks yet. Click a sentence or use the Bookmark button.</p>
            )}
            {bookmarks.map((bm) => (
              <div
                key={bm.bookmark_id}
                className="p-2.5 rounded-lg bg-[#1a1a21] border border-[#262632] flex items-start justify-between gap-2"
              >
                <button
                  onClick={() => onSelectChapter(bm.chapter_id, bm.sentence_index ?? 0)}
                  className="text-left min-w-0 flex-1"
                >
                  <div className="text-xs font-medium text-[#ececef] truncate">{bm.label}</div>
                  {bm.excerpt && <div className="text-[11px] text-[#8d8d9b] line-clamp-2 mt-1">{bm.excerpt}</div>}
                </button>
                <button
                  onClick={() => onDeleteBookmark(bm.bookmark_id)}
                  className="p-1 text-[#7d7d8c] hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "highlights" && (
          <div className="space-y-2">
            {highlights.length === 0 && (
              <p className="text-xs text-[#7d7d8c] px-1">Select text in the reader to save highlights and notes.</p>
            )}
            {highlights.map((hl) => (
              <div
                key={hl.highlight_id}
                className="p-2.5 rounded-lg bg-[#1a1a21] border border-[#262632] space-y-1"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => onSelectChapter(hl.chapter_id)}
                    className="text-left text-xs text-[#f0dec6] line-clamp-3"
                  >
                    “{hl.selected_text}”
                  </button>
                  <button
                    onClick={() => onDeleteHighlight(hl.highlight_id)}
                    className="p-1 text-[#7d7d8c] hover:text-red-400 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {hl.note && <div className="text-[11px] text-[#9c9caa] border-l-2 border-[#d4a373]/50 pl-2">{hl.note}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

