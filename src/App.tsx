import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, X } from "lucide-react";
import { useEffect } from "react";
import { AudiobookPlayerBar } from "./components/audio/AudiobookPlayerBar";
import { FirstRunWizard } from "./components/navigation/FirstRunWizard";
import { Sidebar } from "./components/navigation/Sidebar";
import { HomePage } from "./pages/Home/HomePage";
import { LibraryPage } from "./pages/Library/LibraryPage";
import { ReaderPage } from "./pages/Reader/ReaderPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";
import { VoiceLabPage } from "./pages/VoiceLab/VoiceLabPage";
import { useAppStore } from "./store/useAppStore";

export default function App() {
  const { page, bootstrap, backendReady, isFullscreen, errorToast, setErrorToast } = useAppStore();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0f0f12] text-[#ececef] overflow-hidden">
      <FirstRunWizard />

      {errorToast && (
        <div className="fixed top-4 right-4 z-50 max-w-md rounded-xl bg-[#221719] border border-red-500/40 px-4 py-3 shadow-2xl flex items-start gap-2.5 text-xs text-red-100">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span className="flex-1">{errorToast}</span>
          <button onClick={() => setErrorToast(null)} className="text-red-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {!isFullscreen && <Sidebar />}

        <main className="flex-1 min-w-0 h-full overflow-y-auto bg-[#0f0f12]">
          {!backendReady ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-[#9898a6]">
              <div className="w-8 h-8 rounded-full border-2 border-[#d4a373]/30 border-t-[#d4a373] animate-spin" />
              <span>Starting local NovelFlow AI engine...</span>
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

