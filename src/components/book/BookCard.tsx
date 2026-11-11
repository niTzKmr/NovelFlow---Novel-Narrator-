import { Star, Headphones, BookOpen, Trash2 } from "lucide-react";
import { resolveBackendUrl } from "../../services/api";
import type { BookSummary } from "../../types";

interface BookCardProps {
  book: BookSummary;
  layout?: "grid" | "list";
  onOpen: (bookId: string) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onDelete?: (book: BookSummary) => void;
}

export function BookCard({ book, layout = "grid", onOpen, onToggleFavorite, onDelete }: BookCardProps) {
  const coverSrc = book.cover_url ? resolveBackendUrl(book.cover_url) : null;
  const lastDate = book.last_opened_at ? new Date(book.last_opened_at).toLocaleDateString() : "Unread";

  if (layout === "list") {
    return (
      <div
        onClick={() => onOpen(book.book_id)}
        className="group flex items-center gap-4 p-3 rounded-xl bg-[#16161b] border border-[#25252f] hover:border-[#d4a373]/45 transition-all cursor-pointer"
      >
        <div className="w-12 h-16 rounded-lg overflow-hidden bg-[#22222b] shrink-0 flex items-center justify-center border border-[#2f2f3c]">
          {coverSrc ? (
            <img src={coverSrc} alt={book.title} className="w-full h-full object-cover" />
          ) : (
            <BookOpen className="w-5 h-5 text-[#777785]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[#f1f1f4] truncate">{book.title}</h3>
            {book.collection_name && (
              <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-[#24242d] text-[#b0b0be]">
                {book.collection_name}
              </span>
            )}
          </div>
          <p className="text-xs text-[#8d8d9b] truncate">{book.author}</p>
          <div className="flex items-center gap-4 mt-1.5 text-[11px] text-[#7c7c8a]">
            <span>Read: {book.reading_progress_pct}%</span>
            <span>Listen: {book.listening_progress_pct}%</span>
            <span>{book.total_chapters} chapters</span>
            <span>Opened: {lastDate}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onToggleFavorite(book)}
            className="p-2 rounded-lg hover:bg-[#23232c] text-[#8d8d9b] hover:text-[#d4a373]"
            title="Toggle Favorite"
          >
            <Star className={`w-4 h-4 ${book.is_favorite ? "fill-[#d4a373] text-[#d4a373]" : ""}`} />
          </button>
          {onDelete && (
            <button
              onClick={() => onDelete(book)}
              className="p-2 rounded-lg hover:bg-[#23232c] text-[#8d8d9b] hover:text-red-400"
              title="Remove Book"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => onOpen(book.book_id)}
      className="group rounded-xl bg-[#16161b] border border-[#25252f] hover:border-[#d4a373]/45 p-3.5 transition-all cursor-pointer flex flex-col"
    >
      <div className="relative aspect-[2/3] w-full rounded-lg overflow-hidden bg-gradient-to-b from-[#23232c] to-[#17171d] border border-[#2b2b36] mb-3 flex items-center justify-center">
        {coverSrc ? (
          <img src={coverSrc} alt={book.title} className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300" />
        ) : (
          <div className="p-4 text-center">
            <BookOpen className="w-7 h-7 text-[#d4a373]/70 mx-auto mb-2" />
            <div className="text-xs font-serif text-[#d5d5de] line-clamp-3">{book.title}</div>
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(book);
          }}
          className="absolute top-2 right-2 p-1.5 rounded-full bg-black/55 backdrop-blur-sm text-white/80 hover:text-[#d4a373]"
          title="Favorite"
        >
          <Star className={`w-3.5 h-3.5 ${book.is_favorite ? "fill-[#d4a373] text-[#d4a373]" : ""}`} />
        </button>
      </div>

      <h3 className="text-[13.5px] font-semibold text-[#f1f1f4] line-clamp-1">{book.title}</h3>
      <p className="text-xs text-[#8d8d9b] line-clamp-1 mt-0.5">{book.author}</p>

      <div className="mt-3 pt-2.5 border-t border-[#22222b] space-y-1.5">
        <div className="w-full h-1 rounded-full bg-[#24242d] overflow-hidden">
          <div
            className="h-full bg-[#d4a373] rounded-full transition-all"
            style={{ width: `${Math.max(book.reading_progress_pct, book.listening_progress_pct)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-[#848494]">
          <span className="inline-flex items-center gap-1">
            <Headphones className="w-3 h-3 text-[#d4a373]/80" />
            {book.listening_progress_pct}%
          </span>
          <span>{lastDate}</span>
        </div>
      </div>
    </div>
  );
}

