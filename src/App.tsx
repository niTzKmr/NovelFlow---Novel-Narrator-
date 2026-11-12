import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, X } from "lucide-react";
import { useEffect } from "react";
import { AudiobookPlayerBar } from "./components/audio/AudiobookPlayerBar";
import { NovelFlowLogo } from "./components/brand/NovelFlowLogo";
import { FirstRunWizard } from "./components/navigation/FirstRunWizard";
import { Sidebar } from "./components/navigation/Sidebar";
import { HomePage } from "./pages/Home/HomePage";
import { LibraryPage } from "./pages/Library/LibraryPage";
import { ReaderPage } from "./pages/Reader/ReaderPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";
import { VoiceLabPage } from "./pages/VoiceLab/VoiceLabPage";
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const { page, bootstrap, backendReady, isFullscreen, errorToast, setErrorToast, activeBook } = useAppStore();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0c10] text-[#f4f5f8] overflow-hidden">
      {/* Seamless dark Windows title bar drag strip */}
      {!isFullscreen && (
        <div className="h-[34px] shrink-0 bg-[#0b0c10] border-b border-[#1c1f2b] px-4 pr-36 flex items-center justify-between select-none nf-drag">
          <div className="flex items-center gap-2 text-[11.5px] text-[#8d94a8]">
            <NovelFlowLogo size={17} />
            <span className="font-medium text-[#d5d8e2]">NovelFlow</span>
            {activeBook && page === "reader" && (
              <span className="text-[#6d7489] truncate max-w-md">• {activeBook.title}</span>
            )}
          </div>
        </div>
      )}

      <FirstRunWizard />

      {errorToast && (
        <div className="fixed top-12 right-4 z-50 max-w-md rounded-xl bg-[#22171a] border border-red-500/40 px-4 py-3 shadow-2xl flex items-start gap-2.5 text-xs text-red-100">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span className="flex-1">{errorToast}</span>
          <button onClick={() => setErrorToast(null)} className="text-red-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {!isFullscreen && backendReady && <Sidebar />}

        <main
          className="flex-1 min-w-0 h-full overflow-y-auto bg-[#0b0c10]"
          style={{
            backgroundImage: "radial-gradient(circle at 75% 0%, rgba(229, 169, 94, 0.045), transparent 46%)",
          }}
        >
          {!backendReady ? (
            <div
              className="h-full flex flex-col items-center justify-center px-6 text-center"
              style={{
                background: "radial-gradient(circle at 50% 42%, rgba(229, 169, 94, 0.11), transparent 56%)",
              }}
            >
              <NovelFlowLogo size={84} className="mb-4 drop-shadow-2xl" />
              <h1 className="text-2xl font-semibold tracking-tight text-[#f5f5f7]">NovelFlow</h1>
              <p className="text-xs text-[#8e95a9] mt-1 mb-7">Local AI EPUB Reader &amp; Audiobook Engine</p>

              <div className="w-full max-w-sm h-1.5 rounded-full bg-[#1b1e28] border border-[#252a38] overflow-hidden relative">
                <div className="h-full w-2/5 rounded-full bg-gradient-to-r from-[#d49449] via-[#e5a95e] to-[#f1c382] nf-splash-sweep" />
              </div>
              <span className="text-xs text-[#a4aabb] mt-3">Starting local voice engine...</span>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
                className="h-full"
              >
                {page === "home" && <HomePage />}
                {page === "library" && <LibraryPage />}
                {page === "reader" && <ReaderPage />}
                {page === "voicelab" && <VoiceLabPage />}
                {page === "settings" && <SettingsPage />}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>

      <AudiobookPlayerBar />
    </div>
  );
}
