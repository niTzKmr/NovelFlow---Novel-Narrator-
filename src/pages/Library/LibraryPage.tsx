import { FolderPlus, LayoutGrid, List, Plus, Search, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { BookCard } from "../../components/book/BookCard";
import { api } from "../../services/api";
import { useAppStore } from "../../store/useAppStore";
import type { BookSummary } from "../../types";

type SectionTab = "all" | "continue_reading" | "recently_added" | "recently_played" | "favorites" | "history";

export function LibraryPage() {
  const { books, openBook, refreshBooks, setErrorToast } = useAppStore();
  const [section, setSection] = useState<SectionTab>("all");
  const [collectionFilter, setCollectionFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);

  const collections = useMemo(() => {
    const set = new Set<string>();
    books.forEach((b) => {
      if (b.collection_name) set.add(b.collection_name);
    });
    return Array.from(set).sort();
  }, [books]);

  const filteredBooks = useMemo(() => {
    let list = [...books];
    if (section === "continue_reading") {
      list = list.filter((b) => b.last_opened_at && b.reading_progress_pct < 99.5);
    } else if (section === "recently_played") {
      list = list.filter((b) => b.last_played_at).sort((a, b) => (b.last_played_at || "").localeCompare(a.last_played_at || ""));
    } else if (section === "favorites") {
      list = list.filter((b) => b.is_favorite);
    } else if (section === "history") {
      list = list.filter((b) => b.last_opened_at).sort((a, b) => (b.last_opened_at || "").localeCompare(a.last_opened_at || ""));
    } else {
      list = list.sort((a, b) => b.added_at.localeCompare(a.added_at));
    }

    if (collectionFilter !== "all") {
      list = list.filter((b) => b.collection_name === collectionFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
      );
    }
    return list;
  }, [books, section, collectionFilter, searchQuery]);

  const importFiles = async (files: File[]) => {
    const epubs = files.filter((f) => f.name.toLowerCase().endsWith(".epub"));
    if (epubs.length === 0) {
      setErrorToast("Please select valid .epub files.");
      return;
    }
    setImporting(true);
    try {
      for (const f of epubs) {
        await api.importEpubFile(f);
      }
      await refreshBooks();
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleBrowse = async () => {
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
          if (input.files) await importFiles(Array.from(input.files));
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

  const handleDeleteBook = async (book: BookSummary) => {
    await api.deleteBook(book.book_id);
    await refreshBooks();
  };

  const handleAssignCollection = async (book: BookSummary) => {
    const name = window.prompt("Collection name (leave blank to clear):", book.collection_name || "");
    if (name === null) return;
    await api.patchBook(book.book_id, { collection_name: name });
    await refreshBooks();
  };

  return (
    <div
      className="p-7 max-w-6xl mx-auto space-y-6 min-h-full relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        await importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-[#d4a373] bg-[#16161b] px-10 py-8 text-center space-y-2">
            <Upload className="w-9 h-9 text-[#d4a373] mx-auto" />
            <div className="text-base font-medium text-white">Drop EPUB files to import locally</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f4f4f7]">Library</h1>
          <p className="text-sm text-[#8e8e9c]">{books.length} local EPUB books</p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#7f7f8e] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter title or author..."
              className="pl-8 pr-3 py-2 rounded-xl bg-[#16161b] border border-[#262630] text-xs text-[#ececef] outline-none focus:border-[#d4a373] w-56"
            />
          </div>

          <div className="flex items-center rounded-xl bg-[#16161b] border border-[#262630] p-0.5">
            <button
              onClick={() => setLayout("grid")}
              className={`p-1.5 rounded-lg ${layout === "grid" ? "bg-[#25252f] text-white" : "text-[#848494]"}`}
              title="Grid View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setLayout("list")}
              className={`p-1.5 rounded-lg ${layout === "list" ? "bg-[#25252f] text-white" : "text-[#848494]"}`}
              title="List View"
            >
              <List className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={handleBrowse}
            disabled={importing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#d4a373] text-[#141210] text-xs font-semibold hover:brightness-105 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {importing ? "Importing..." : "Add EPUB"}
          </button>
        </div>
      </div>

      {/* Category Pills & Collection Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {[
            { id: "all" as const, label: "All Books" },
            { id: "continue_reading" as const, label: "Continue Reading" },
            { id: "recently_added" as const, label: "Recently Added" },
            { id: "recently_played" as const, label: "Recently Played" },
            { id: "favorites" as const, label: "Favorites" },
            { id: "history" as const, label: "Reading History" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setSection(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs transition ${
                section === t.id
                  ? "bg-[#d4a373]/18 text-[#d4a373] border border-[#d4a373]/35 font-medium"
                  : "bg-[#16161b] border border-[#25252f] text-[#9b9ba9] hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <FolderPlus className="w-3.5 h-3.5 text-[#888896]" />
          <select
            value={collectionFilter}
            onChange={(e) => setCollectionFilter(e.target.value)}
            className="bg-[#16161b] border border-[#262630] rounded-lg px-2.5 py-1.5 text-xs text-[#ececef] outline-none"
          >
            <option value="all">All Collections</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filteredBooks.length === 0 ? (
        <div className="rounded-2xl bg-[#16161b] border border-[#25252f] p-12 text-center text-sm text-[#8d8d9b]">
          No books match this filter. Drag and drop `.epub` files anywhere here or click Add EPUB.
        </div>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filteredBooks.map((b) => (
            <div key={b.book_id} className="relative group">
              <BookCard book={b} layout="grid" onOpen={openBook} onToggleFavorite={toggleFavorite} />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleAssignCollection(b);
                }}
                className="opacity-0 group-hover:opacity-100 absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/65 text-[10px] text-white/90 hover:text-[#d4a373] transition"
              >
                {b.collection_name || "+ Collection"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredBooks.map((b) => (
            <BookCard
              key={b.book_id}
              book={b}
              layout="list"
              onOpen={openBook}
              onToggleFavorite={toggleFavorite}
              onDelete={handleDeleteBook}
            />
          ))}
        </div>
      )}
    </div>
  );
}

