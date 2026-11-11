import { ArrowRight, BookOpen, Headphones, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { BookCard } from "../../components/book/BookCard";
import { api, resolveBackendUrl } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";
import type { BookSummary } from "../../types";

export function HomePage() {
  const { books, openBook, refreshBooks, setPage, setErrorToast, voices, settings } = useAppStore();
  const [importing, setImporting] = useState(false);

  const continueList = books.filter((b) => b.last_opened_at && b.reading_progress_pct < 99.5);
  const recentlyPlayed = books
    .filter((b) => b.last_played_at)
    .sort((a, b) => (b.last_played_at || "").localeCompare(a.last_played_at || ""));
  const recentlyAdded = [...books].sort((a, b) => b.added_at.localeCompare(a.added_at));
  const favorites = books.filter((b) => b.is_favorite);
  const heroBook = continueList[0] || books[0] || null;
  const preferredVoice = voices.find((v) => v.voice_id === settings?.preferred_voice_id);

  const handleImport = async () => {
    setImporting(true);
    try {
      if (window.novelflow) {
        const picked = await window.novelflow.openEpubFiles();
        for (const f of picked) {
          await api.importEpubFile(f);
        }
        if (picked.length > 0) await refreshBooks();
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".epub";
        input.multiple = true;
        input.onchange = async () => {
          if (!input.files) return;
          for (const f of Array.from(input.files)) {
            await api.importEpubFile(f);
          }
          await refreshBooks();
        };
        input.click();
      }
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const toggleFavorite = async (book: BookSummary) => {
    await api.patchBook(book.book_id, { is_favorite: !book.is_favorite });
    await refreshBooks();
  };

  return (
    <div className="p-7 max-w-6xl mx-auto space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f4f4f7]">Welcome back</h1>
          <p className="text-sm text-[#8e8e9c] mt-0.5">
            Active Narrator: <span className="text-[#d4a373] font-medium">{preferredVoice?.name || "Deep Cinematic Narrator"}</span> • 100% Local AI
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setPage("voicelab")}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#1a1a21] border border-[#2a2a35] text-xs font-medium text-[#e6e6ec] hover:border-[#d4a373]/50"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#d4a373]" />
            Voice Lab
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {importing ? "Importing..." : "Import EPUB"}
          </button>
        </div>
      </div>

      {/* Hero Continue Reading */}
      {heroBook ? (
        <div className="rounded-2xl bg-gradient-to-br from-[#191920] to-[#131317] border border-[#282834] p-6 flex flex-col sm:flex-row gap-6 items-center">
          <div className="w-28 h-40 rounded-xl overflow-hidden bg-[#22222b] border border-[#2f2f3d] shrink-0 flex items-center justify-center">
            {heroBook.cover_url ? (
              <img src={resolveBackendUrl(heroBook.cover_url)} alt={heroBook.title} className="w-full h-full object-cover" />
            ) : (
              <BookOpen className="w-8 h-8 text-[#d4a373]/70" />
            )}
          </div>
          <div className="flex-1 min-w-0 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-[#d4a373] font-semibold">
              {heroBook.last_opened_at ? "Continue Reading" : "Ready in Library"}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-[#f3f3f7] truncate">{heroBook.title}</h2>
              <p className="text-sm text-[#9595a3]">{heroBook.author} • {heroBook.total_chapters} chapters</p>
            </div>
            <div className="max-w-md space-y-1">
              <div className="h-1.5 w-full rounded-full bg-[#24242e] overflow-hidden">
                <div
                  className="h-full bg-[#d4a373] rounded-full"
                  style={{ width: `${Math.max(heroBook.reading_progress_pct, heroBook.listening_progress_pct)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-[#848494]">
                <span>Reading: {heroBook.reading_progress_pct}%</span>
                <span>Listening: {heroBook.listening_progress_pct}%</span>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => openBook(heroBook.book_id)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105"
              >
                <Headphones className="w-3.5 h-3.5" />
                Open Reader & Narrator
              </button>
              <button
                onClick={() => setPage("library")}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#21212a] text-xs text-[#d6d6e0] hover:text-white"
              >
                All Books <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl bg-[#16161b] border border-dashed border-[#2f2f3c] p-10 text-center space-y-3">
          <BookOpen className="w-10 h-10 text-[#d4a373]/80 mx-auto" />
          <h2 className="text-lg font-medium text-[#f1f1f4]">Your local library is ready</h2>
          <p className="text-sm text-[#8f8f9e] max-w-md mx-auto">
            Import any EPUB 2 or EPUB 3 novel to read distraction-free and generate unlimited offline AI narration.
          </p>
          <button
            onClick={handleImport}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105"
          >
            <Plus className="w-4 h-4" />
            Import Your First EPUB
          </button>
        </div>
      )}

      {recentlyPlayed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[#ececef]">Recently Played</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-4">
            {recentlyPlayed.slice(0, 5).map((b) => (
              <BookCard key={b.book_id} book={b} onOpen={openBook} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        </section>
      )}

      {recentlyAdded.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[#ececef]">Recently Added</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-4">
            {recentlyAdded.slice(0, 5).map((b) => (
              <BookCard key={b.book_id} book={b} onOpen={openBook} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        </section>
      )}

      {favorites.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[#ececef]">Favorites</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-4">
            {favorites.slice(0, 5).map((b) => (
              <BookCard key={b.book_id} book={b} onOpen={openBook} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

