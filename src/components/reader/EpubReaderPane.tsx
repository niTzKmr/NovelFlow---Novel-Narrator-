import ePub, { Book, Rendition } from "epubjs";
import { Bookmark, Highlighter, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveBackendUrl } from "../../services/api";
import type { ChapterContent, ReaderPreferences, SentenceItem } from "../../types";

interface EpubReaderPaneProps {
  bookId: string;
  epubUrl: string;
  chapter: ChapterContent;
  prefs: ReaderPreferences;
  activeSentenceIndex: number | null;
  renderMode: "epubjs" | "clean";
  onSentenceNarrate: (sentenceIndex: number) => void;
  onAddBookmark: (sentenceIndex: number, excerpt: string) => void;
  onAddHighlight: (selectedText: string, note?: string) => void;
  onCfiChange?: (cfi: string) => void;
}

function resolveThemeColors(prefs: ReaderPreferences): { bg: string; fg: string; accentBg: string } {
  switch (prefs.theme) {
    case "light":
      return { bg: "#faf8f4", fg: "#1c1c21", accentBg: "rgba(180, 110, 40, 0.22)" };
    case "sepia":
      return { bg: "#f3ead8", fg: "#3a2e21", accentBg: "rgba(168, 102, 36, 0.24)" };
    case "dark":
      return { bg: "#09090b", fg: "#e4e4e7", accentBg: "rgba(212, 163, 115, 0.28)" };
    case "custom":
      return {
        bg: prefs.custom_bg || "#18181b",
        fg: prefs.custom_fg || "#e4e4e7",
        accentBg: "rgba(212, 163, 115, 0.28)",
      };
    case "charcoal":
    default:
      return { bg: "#141418", fg: "#e6e6eb", accentBg: "rgba(212, 163, 115, 0.28)" };
  }
}

/**
 * Walk DOM text nodes in order and wrap exact character ranges matching canonical sentences
 * into <span class="nf-sentence" data-sentence-idx="N"> without losing <em>/<strong>/Unicode markup.
 */
function tagSentencesInDocument(doc: Document, sentences: SentenceItem[]): number {
  const body = doc.body;
  if (!body || sentences.length === 0) return 0;

  // Build flat normalized character map across text nodes inside readable blocks
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const segments: { node: Text; text: string }[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const tNode = n as Text;
    if (tNode.parentElement?.closest("script, style")) continue;
    if (tNode.nodeValue && tNode.nodeValue.trim().length > 0) {
      segments.push({ node: tNode, text: tNode.nodeValue });
    }
  }

  let taggedCount = 0;
  let segCursor = 0;
  let charCursor = 0;

  const findNextMatch = (needle: string): { startSeg: number; startOff: number; endSeg: number; endOff: number } | null => {
    const cleanNeedle = needle.replace(/\s+/g, " ").trim();
    if (!cleanNeedle) return null;
    const prefix = cleanNeedle.slice(0, Math.min(18, cleanNeedle.length));

    for (let si = segCursor; si < segments.length; si++) {
      const txt = segments[si].text;
      const startSearch = si === segCursor ? charCursor : 0;
      const idx = txt.indexOf(prefix.slice(0, Math.min(8, prefix.length)), startSearch);
      if (idx === -1) continue;

      // Consume exact needle length ignoring collapsed whitespace differences
      let curS = si;
      let curO = idx;
      let ni = 0;
      while (curS < segments.length && ni < cleanNeedle.length) {
        const sTxt = segments[curS].text;
        while (curO < sTxt.length && ni < cleanNeedle.length) {
          const dc = sTxt[curO];
          const nc = cleanNeedle[ni];
          if (/\s/.test(nc)) {
            ni++;
            while (curO < sTxt.length && /\s/.test(sTxt[curO])) curO++;
            continue;
          }
          if (/\s/.test(dc)) {
            curO++;
            continue;
          }
          if (dc === nc) {
            curO++;
            ni++;
          } else {
            break;
          }
        }
        if (ni < cleanNeedle.length && curO >= sTxt.length) {
          curS++;
          curO = 0;
        } else if (ni < cleanNeedle.length) {
          break;
        }
      }
      if (ni >= cleanNeedle.length) {
        return { startSeg: si, startOff: idx, endSeg: curS, endOff: curO };
      }
    }
    return null;
  };

  // Wrap matched ranges in reverse-safe order? Wait: splitting single/cross text nodes sequentially works cleanly
  // if we adjust current segment slice after splitting!
  for (const s of sentences) {
    const match = findNextMatch(s.text);
    if (!match) continue;

    if (match.startSeg === match.endSeg) {
      const tNode = segments[match.startSeg].node;
      const full = tNode.nodeValue || "";
      const before = full.slice(0, match.startOff);
      const mid = full.slice(match.startOff, match.endOff);
      const after = full.slice(match.endOff);

      const parent = tNode.parentNode;
      if (parent && mid) {
        const span = doc.createElement("span");
        span.className = "nf-sentence";
        span.setAttribute("data-sentence-idx", String(s.sentence_index));
        span.textContent = mid;

        const frag = doc.createDocumentFragment();
        if (before) frag.appendChild(doc.createTextNode(before));
        frag.appendChild(span);
        const afterNode = doc.createTextNode(after);
        frag.appendChild(afterNode);
        parent.replaceChild(frag, tNode);

        segments[match.startSeg] = { node: afterNode, text: after };
        segCursor = match.startSeg;
        charCursor = 0;
        taggedCount++;
      }
    } else {
      // Cross-element sentence (e.g., spanning <em> or <strong>): wrap individual slices in spans with same data-sentence-idx
      for (let si = match.startSeg; si <= match.endSeg; si++) {
        const tNode = segments[si].node;
        const full = tNode.nodeValue || "";
        const sOff = si === match.startSeg ? match.startOff : 0;
        const eOff = si === match.endSeg ? match.endOff : full.length;
        const before = full.slice(0, sOff);
        const mid = full.slice(sOff, eOff);
        const after = full.slice(eOff);
        const parent = tNode.parentNode;
        if (!parent || !mid) continue;

        const span = doc.createElement("span");
        span.className = "nf-sentence";
        span.setAttribute("data-sentence-idx", String(s.sentence_index));
        span.textContent = mid;

        const frag = doc.createDocumentFragment();
        if (before) frag.appendChild(doc.createTextNode(before));
        frag.appendChild(span);
        const afterNode = si === match.endSeg ? doc.createTextNode(after) : null;
        if (afterNode) frag.appendChild(afterNode);
        parent.replaceChild(frag, tNode);

        if (si === match.endSeg && afterNode) {
          segments[si] = { node: afterNode, text: after };
        }
      }
      segCursor = match.endSeg;
      charCursor = 0;
      taggedCount++;
    }
  }
  return taggedCount;
}

export function EpubReaderPane({
  bookId,
  epubUrl,
  chapter,
  prefs,
  activeSentenceIndex,
  renderMode,
  onSentenceNarrate,
  onAddBookmark,
  onAddHighlight,
  onCfiChange,
}: EpubReaderPaneProps) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const cleanScrollRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const iframeDocRef = useRef<Document | null>(null);

  const [epubFailed, setEpubFailed] = useState(false);
  const [clickedSentence, setClickedSentence] = useState<{ index: number; text: string } | null>(null);
  const [selectedTextPopup, setSelectedTextPopup] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  const colors = useMemo(() => resolveThemeColors(prefs), [prefs]);

  const applyHighlightToDoc = useCallback(
    (doc: Document | null, sentenceIdx: number | null) => {
      if (!doc) return;
      doc.querySelectorAll(".nf-sentence-active").forEach((el) => el.classList.remove("nf-sentence-active"));
      if (sentenceIdx === null) return;
      const targets = doc.querySelectorAll(`[data-sentence-idx="${sentenceIdx}"]`);
      targets.forEach((el) => el.classList.add("nf-sentence-active"));
      if (targets.length > 0) {
        (targets[0] as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    []
  );

  // Initialize epub.js Book when bookId changes and epubjs mode is active
  useEffect(() => {
    if (renderMode !== "epubjs") return;
    setEpubFailed(false);
    const container = viewerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const fullEpubUrl = resolveBackendUrl(epubUrl);
    const epubBook = ePub(fullEpubUrl);
    bookRef.current = epubBook;

    const rendition = epubBook.renderTo(container, {
      width: "100%",
      height: "100%",
      flow: "scrolled-doc",
      allowScriptedContent: false,
    });
    renditionRef.current = rendition;

    rendition.on("relocated", (loc: { start?: { cfi?: string } }) => {
      if (loc?.start?.cfi && onCfiChange) {
        onCfiChange(loc.start.cfi);
      }
    });

    return () => {
      iframeDocRef.current = null;
      try {
        rendition.destroy();
        epubBook.destroy();
      } catch {
        // ignore teardown issues
      }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [bookId, epubUrl, renderMode]);

  // Display current chapter in epub.js and attach sentence tagging + style hook
  useEffect(() => {
    if (renderMode !== "epubjs" || !renditionRef.current) return;
    const rendition = renditionRef.current;

    const handleContent = (contents: { document: Document }) => {
      const doc = contents.document;
      iframeDocRef.current = doc;

      // Inject reader theme and typography stylesheet into epub.js iframe
      let styleEl = doc.getElementById("nf-injected-style") as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = doc.createElement("style");
        styleEl.id = "nf-injected-style";
        doc.head.appendChild(styleEl);
      }
      styleEl.textContent = `
        html, body {
          background: ${colors.bg} !important;
          color: ${colors.fg} !important;
          font-family: ${prefs.font_family} !important;
          font-size: ${prefs.font_size}px !important;
          line-height: ${prefs.line_height} !important;
          margin: 0 auto !important;
          padding: 24px 20px 80px !important;
          max-width: ${prefs.reading_width}px !important;
        }
        p, li, blockquote {
          margin-bottom: ${prefs.paragraph_spacing}px !important;
          color: ${colors.fg} !important;
        }
        img { max-width: 100% !important; height: auto !important; border-radius: 8px; }
        .nf-sentence { border-radius: 4px; padding: 1px 2px; cursor: pointer; transition: background-color 160ms ease; }
        .nf-sentence:hover { background-color: rgba(212, 163, 115, 0.16); }
        .nf-sentence-active { background-color: ${colors.accentBg} !important; box-shadow: 0 0 0 2px rgba(212,163,115,0.22); }
      `;

      // Tag sentences once per chapter load
      if (!doc.body.dataset.nfTagged) {
        doc.body.dataset.nfTagged = "1";
        tagSentencesInDocument(doc, chapter.sentences);
        doc.body.addEventListener("click", (ev) => {
          const sel = doc.getSelection()?.toString().trim();
          if (sel && sel.length > 2) {
            setSelectedTextPopup(sel);
            return;
          }
          const target = (ev.target as HTMLElement | null)?.closest(".nf-sentence") as HTMLElement | null;
          if (target) {
            const idx = Number(target.getAttribute("data-sentence-idx"));
            if (!Number.isNaN(idx)) {
              const sObj = chapter.sentences.find((x) => x.sentence_index === idx);
              setClickedSentence({ index: idx, text: sObj?.text || target.textContent || "" });
              setSelectedTextPopup(null);
            }
          }
        });
      }
      applyHighlightToDoc(doc, activeSentenceIndex);
    };

    rendition.hooks.content.register(handleContent);
    rendition.display(chapter.href).catch(() => {
      setEpubFailed(true);
    });
  }, [chapter.chapter_id, chapter.href, chapter.sentences, renderMode, colors, prefs, applyHighlightToDoc]);

  // Sync active sentence highlight inside whichever DOM is rendered
  useEffect(() => {
    if (renderMode === "epubjs" && !epubFailed) {
      applyHighlightToDoc(iframeDocRef.current, activeSentenceIndex);
    } else if (cleanScrollRef.current) {
      applyHighlightToDoc(document, activeSentenceIndex);
    }
  }, [activeSentenceIndex, renderMode, epubFailed, applyHighlightToDoc]);

  // Update CSS dynamically in epub.js iframe when user adjusts typography/theme without reloading book
  useEffect(() => {
    const doc = iframeDocRef.current;
    if (!doc) return;
    const styleEl = doc.getElementById("nf-injected-style");
    if (styleEl) {
      styleEl.textContent = `
        html, body {
          background: ${colors.bg} !important;
          color: ${colors.fg} !important;
          font-family: ${prefs.font_family} !important;
          font-size: ${prefs.font_size}px !important;
          line-height: ${prefs.line_height} !important;
          margin: 0 auto !important;
          padding: 24px 20px 80px !important;
          max-width: ${prefs.reading_width}px !important;
        }
        p, li, blockquote {
          margin-bottom: ${prefs.paragraph_spacing}px !important;
          color: ${colors.fg} !important;
        }
        img { max-width: 100% !important; height: auto !important; border-radius: 8px; }
        .nf-sentence { border-radius: 4px; padding: 1px 2px; cursor: pointer; transition: background-color 160ms ease; }
        .nf-sentence:hover { background-color: rgba(212, 163, 115, 0.16); }
        .nf-sentence-active { background-color: ${colors.accentBg} !important; box-shadow: 0 0 0 2px rgba(212,163,115,0.22); }
      `;
    }
  }, [colors, prefs]);

  // Build clean prose view with exact sentence spans and preserved embedded images
  const cleanHtmlDoc = useMemo(() => {
    if (renderMode === "epubjs" && !epubFailed) return "";
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${chapter.html}</div>`, "text/html");
    // Rewrite relative src if needed
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("/api/")) {
        img.setAttribute("src", resolveBackendUrl(src));
      }
    });
    tagSentencesInDocument(doc, chapter.sentences);
    return doc.body.innerHTML;
  }, [chapter.html, chapter.sentences, renderMode, epubFailed]);

  const showCleanView = renderMode === "clean" || epubFailed;

  return (
    <div
      className="relative flex-1 h-full overflow-hidden transition-colors duration-200"
      style={{ backgroundColor: colors.bg, color: colors.fg }}
    >
      {!showCleanView ? (
        <div ref={viewerRef} className="w-full h-full" />
      ) : (
        <div
          ref={cleanScrollRef}
          className="w-full h-full overflow-y-auto px-6 py-8"
          onMouseUp={() => {
            const sel = window.getSelection()?.toString().trim();
            if (sel && sel.length > 2) {
              setSelectedTextPopup(sel);
              setClickedSentence(null);
            }
          }}
          onClick={(e) => {
            const sel = window.getSelection()?.toString().trim();
            if (sel && sel.length > 2) return;
            const span = (e.target as HTMLElement | null)?.closest(".nf-sentence") as HTMLElement | null;
            if (span) {
              const idx = Number(span.getAttribute("data-sentence-idx"));
              if (!Number.isNaN(idx)) {
                const sObj = chapter.sentences.find((x) => x.sentence_index === idx);
                setClickedSentence({ index: idx, text: sObj?.text || span.textContent || "" });
                setSelectedTextPopup(null);
              }
            }
          }}
        >
          <div
            className="mx-auto nf-prose"
            style={
              {
                maxWidth: `${prefs.reading_width}px`,
                fontFamily: prefs.font_family,
                fontSize: `${prefs.font_size}px`,
                lineHeight: prefs.line_height,
                "--nf-para-spacing": `${prefs.paragraph_spacing}px`,
              } as React.CSSProperties
            }
            dangerouslySetInnerHTML={{ __html: cleanHtmlDoc }}
          />
        </div>
      )}

      {/* Floating Sentence Action Bar */}
      {clickedSentence && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 bg-[#18181f]/95 backdrop-blur-md border border-[#32323f] rounded-xl px-3.5 py-2 shadow-2xl flex items-center gap-2 text-xs text-[#ececef]">
          <span className="text-[#9a9aa8] max-w-[220px] truncate mr-1">
            “{clickedSentence.text}”
          </span>
          <button
            onClick={() => {
              onSentenceNarrate(clickedSentence.index);
              setClickedSentence(null);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#d4a373] text-[#141210] font-semibold hover:brightness-105"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            Narrate from here
          </button>
          <button
            onClick={() => {
              onAddBookmark(clickedSentence.index, clickedSentence.text);
              setClickedSentence(null);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#24242f] hover:bg-[#2d2d3b]"
          >
            <Bookmark className="w-3.5 h-3.5 text-[#d4a373]" />
            Bookmark
          </button>
          <button
            onClick={() => setClickedSentence(null)}
            className="px-2 py-1.5 text-[#888896] hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Floating Text Selection Highlight & Note Bar */}
      {selectedTextPopup && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 bg-[#18181f]/95 backdrop-blur-md border border-[#32323f] rounded-xl p-3 shadow-2xl text-xs text-[#ececef] max-w-md space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[#9a9aa8] truncate">Selected: “{selectedTextPopup}”</span>
            <button onClick={() => { setSelectedTextPopup(null); setShowNoteInput(false); }} className="text-[#888896] hover:text-white">
              Close
            </button>
          </div>
          {showNoteInput && (
            <input
              type="text"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Optional reading note..."
              className="w-full px-2.5 py-1.5 rounded-lg bg-[#111116] border border-[#2c2c38] text-xs outline-none focus:border-[#d4a373]"
            />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onAddHighlight(selectedTextPopup, noteDraft.trim() || undefined);
                setSelectedTextPopup(null);
                setNoteDraft("");
                setShowNoteInput(false);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#d4a373] text-[#141210] font-semibold"
            >
              <Highlighter className="w-3.5 h-3.5" />
              Save Highlight
            </button>
            <button
              onClick={() => setShowNoteInput((v) => !v)}
              className="px-2.5 py-1.5 rounded-lg bg-[#24242f] hover:bg-[#2d2d3b]"
            >
              {showNoteInput ? "Hide Note" : "Add Note"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

