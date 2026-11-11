import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Maximize2,
  Minimize2,
  PanelLeft,
  Type,
} from "lucide-react";
import { useState } from "react";
import { EpubReaderPane } from "../../components/reader/EpubReaderPane";
import { ReaderSettingsPopover } from "../../components/reader/ReaderSettingsPopover";
import { ReaderSidebar } from "../../components/reader/ReaderSidebar";
import { api } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";

export function ReaderPage() {
  const {
    activeBook,
    activeChapter,
    bookmarks,
    highlights,
    settings,
    activeSentenceIndex,
    isFullscreen,
    setPage,
    loadChapter,
    refreshAnnotations,
    updateReaderPrefs,
    startNarration,
    toggleFullscreen,
    setErrorToast,
  } = useAppStore();

  const [showSidebar, setShowSidebar] = useState(true);
  const [showTypography, setShowTypography] = useState(false);
  const [renderMode, setRenderMode] = useState<"epubjs" | "clean">("epubjs");

  if (!activeBook || !activeChapter || !settings) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[#8d8d9b]">
        Select a book from your Library to start reading.
      </div>
    );
  }

  const chapterCount = activeBook.chapters.length;
  const curIdx = activeChapter.chapter_index;
  const prevChapter = curIdx > 0 ? activeBook.chapters[curIdx - 1] : null;
  const nextChapter = curIdx + 1 < chapterCount ? activeBook.chapters[curIdx + 1] : null;

  const totalSentences = Math.max(1, activeChapter.sentences.length);
  const chapPct = Math.round(((curIdx + (activeSentenceIndex ?? 0) / totalSentences) / Math.max(1, chapterCount)) * 100);

  const handleBookmark = async (sentenceIdx?: number, excerpt?: string) => {
    try {
      const idx = sentenceIdx ?? activeSentenceIndex ?? 0;
      const sent = activeChapter.sentences.find((s) => s.sentence_index === idx);
      await api.addBookmark(activeBook.book_id, {
        chapter_id: activeChapter.chapter_id,
        chapter_index: activeChapter.chapter_index,
        label: `${activeChapter.title} • Sentence ${idx + 1}`,
        sentence_index: idx,
        excerpt: excerpt || sent?.text || "",
      });
      await refreshAnnotations(activeBook.book_id);
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleHighlight = async (selectedText: string, note?: string) => {
    try {
      await api.addHighlight(activeBook.book_id, {
        chapter_id: activeChapter.chapter_id,
        chapter_index: activeChapter.chapter_index,
        selected_text: selectedText,
        note,
      });
      await refreshAnnotations(activeBook.book_id);
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0f0f12]">
      {/* Restrained Distraction-Free Top Reader Toolbar */}
      <header className="h-12 shrink-0 bg-[#141418] border-b border-[#24242e] px-4 flex items-center justify-between gap-3 select-none relative">
        <div className="flex items-center gap-2 min-w-0">
          {!isFullscreen && (
            <button
              onClick={() => setPage("library")}
              className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222c]"
              title="Back to Library"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setShowSidebar((s) => !s)}
            className={`p-1.5 rounded-lg ${showSidebar ? "bg-[#24242e] text-[#d4a373]" : "text-[#9d9daa] hover:text-white"}`}
            title="Toggle Chapters & Annotations"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 ml-1">
            <div className="text-xs font-medium text-[#ececef] truncate">
              {activeBook.title} <span className="text-[#787886]">• {activeChapter.title}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#888896] tabular-nums mr-1">{chapPct}%</span>

          <button
            onClick={() => prevChapter && loadChapter(prevChapter.chapter_id, 0, false)}
            disabled={!prevChapter}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white disabled:opacity-30"
            title="Previous Chapter"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => nextChapter && loadChapter(nextChapter.chapter_id, 0, false)}
            disabled={!nextChapter}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white disabled:opacity-30"
            title="Next Chapter"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => setRenderMode((m) => (m === "epubjs" ? "clean" : "epubjs"))}
            className="px-2.5 py-1 rounded-lg bg-[#1d1d24] border border-[#2b2b36] text-[11px] text-[#b4b4c2] hover:text-white"
            title="Switch between EPUB.js layout and Clean Prose Sync layout"
          >
            {renderMode === "epubjs" ? "EPUB View" : "Prose Sync"}
          </button>

          <button
            onClick={() => startNarration(activeSentenceIndex ?? 0)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105"
          >
            <Headphones className="w-3.5 h-3.5" />
            Narrate
          </button>

          <button
            onClick={() => handleBookmark()}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-[#d4a373] hover:bg-[#22222c]"
            title="Bookmark Current Position"
          >
            <Bookmark className="w-4 h-4" />
          </button>

          <button
            onClick={() => setShowTypography((s) => !s)}
            className={`p-1.5 rounded-lg ${showTypography ? "bg-[#24242e] text-[#d4a373]" : "text-[#9d9daa] hover:text-white"}`}
            title="Typography & Theme"
          >
            <Type className="w-4 h-4" />
          </button>

          <button
            onClick={() => toggleFullscreen()}
            className="p-1.5 rounded-lg text-[#9d9daa] hover:text-white hover:bg-[#22222c]"
            title="Toggle Fullscreen"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>

        {showTypography && (
          <div className="absolute right-4 top-13 z-40">
            <ReaderSettingsPopover prefs={settings.reader} onChange={updateReaderPrefs} />
          </div>
        )}
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {showSidebar && (
          <ReaderSidebar
            bookId={activeBook.book_id}
            chapters={activeBook.chapters}
            activeChapterIndex={activeChapter.chapter_index}
            bookmarks={bookmarks}
            highlights={highlights}
            onSelectChapter={(cid, sentIdx) => loadChapter(cid, sentIdx ?? 0, false)}
            onDeleteBookmark={async (id) => {
              await api.deleteBookmark(id);
              await refreshAnnotations(activeBook.book_id);
            }}
            onDeleteHighlight={async (id) => {
              await api.deleteHighlight(id);
              await refreshAnnotations(activeBook.book_id);
            }}
            onClose={() => setShowSidebar(false)}
          />
        )}

        <EpubReaderPane
          bookId={activeBook.book_id}
          epubUrl={activeBook.epub_url}
          chapter={activeChapter}
          prefs={settings.reader}
          activeSentenceIndex={activeSentenceIndex}
          renderMode={renderMode}
          onSentenceNarrate={(idx) => startNarration(idx)}
          onAddBookmark={(idx, excerpt) => handleBookmark(idx, excerpt)}
          onAddHighlight={(txt, note) => handleHighlight(txt, note)}
          onCfiChange={(cfi) => {
            api
              .saveProgress(activeBook.book_id, {
                chapter_id: activeChapter.chapter_id,
                chapter_index: activeChapter.chapter_index,
                cfi,
                sentence_index: activeSentenceIndex ?? 0,
                audio_position_sec: 0,
                progress_pct: chapPct,
                is_audio_playing: false,
              })
              .catch(() => {});
          }}
        />
      </div>
    </div>
  );
}

