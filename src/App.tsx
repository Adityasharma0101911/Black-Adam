import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BarChart3, CloudOff, History, ListMusic, Maximize2, Minus, PictureInPicture2, Settings, Square, X, Zap } from "lucide-react";
import { AppProvider, useApp } from "./lib/store";
import { BoltGlyph } from "./components/Bolt";
import { Cover } from "./components/SongHero";
import { ListenView } from "./views/Listen";
import { HistoryView } from "./views/History";
import { TracklistView } from "./views/Tracklist";
import { StatsView } from "./views/Stats";
import { SettingsView } from "./views/Settings";
import { checkForUpdate } from "./lib/updater";

const VIEWS = [
  { id: "listen", label: "Listen", icon: Zap, el: <ListenView /> },
  { id: "history", label: "History", icon: History, el: <HistoryView /> },
  { id: "tracklist", label: "Tracklists", icon: ListMusic, el: <TracklistView /> },
  { id: "stats", label: "Stats", icon: BarChart3, el: <StatsView /> },
  { id: "settings", label: "Settings", icon: Settings, el: <SettingsView /> },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

const win = getCurrentWindow();
const FULL = new LogicalSize(1040, 700);
const MINI = new LogicalSize(380, 88);

function TitleBar({ onMini }: { onMini: () => void }) {
  return (
    <div data-tauri-drag-region className="flex h-10 shrink-0 items-center pl-4 select-none">
      <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2">
        <BoltGlyph className="h-4 w-4" striped={false} />
        <span className="text-[13px] font-semibold tracking-wide">Black Adam</span>
      </div>
      <div className="ml-auto flex h-full">
        <WinBtn label="Mini player" onClick={onMini}><PictureInPicture2 className="h-3.5 w-3.5" /></WinBtn>
        <WinBtn label="Minimize" onClick={() => win.minimize()}><Minus className="h-4 w-4" /></WinBtn>
        <WinBtn label="Maximize" onClick={() => win.toggleMaximize()}><Square className="h-3 w-3" /></WinBtn>
        <WinBtn label="Close" onClick={() => win.close()} danger><X className="h-4 w-4" /></WinBtn>
      </div>
    </div>
  );
}

function WinBtn({ children, label, onClick, danger }: { children: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={`grid w-11 cursor-pointer place-items-center text-muted transition ${danger ? "hover:bg-red-600 hover:text-white" : "hover:bg-white/8 hover:text-fg"}`}>
      {children}
    </button>
  );
}

function Sidebar({ view, setView }: { view: ViewId; setView: (v: ViewId) => void }) {
  const { listening, queue, latest } = useApp();
  return (
    <nav className="flex w-[188px] shrink-0 flex-col gap-1 px-3 pt-2 pb-4" aria-label="Main">
      {VIEWS.map((v) => {
        const active = v.id === view;
        return (
          <button key={v.id} onClick={() => setView(v.id)} aria-current={active ? "page" : undefined} className={`relative flex h-10 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm font-medium transition ${active ? "text-fg" : "text-muted hover:text-fg"}`}>
            {active && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-xl bg-white/[0.07]" transition={{ type: "spring", stiffness: 400, damping: 34 }} />}
            <v.icon className={`relative h-[18px] w-[18px] ${active ? "text-gold" : ""}`} />
            <span className="relative">{v.label}</span>
            {v.id === "listen" && listening && <span className="relative ml-auto h-2 w-2 animate-pulse rounded-full bg-gold" aria-label="Listening" />}
          </button>
        );
      })}
      <div className="mt-auto space-y-2">
        {queue > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-xs text-muted" title="Recordings made offline. They'll be identified when you're back online.">
            <CloudOff className="h-3.5 w-3.5 text-gold" /> {queue} waiting to identify
          </div>
        )}
        {latest && view !== "listen" && (
          <button onClick={() => setView("listen")} className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-2 text-left transition hover:bg-white/[0.05]">
            <Cover song={latest} className="h-9 w-9 shrink-0 rounded-md" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{latest.title}</p>
              <p className="truncate text-[11px] text-muted">{latest.artist}</p>
            </div>
          </button>
        )}
      </div>
    </nav>
  );
}

function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }} className={`pointer-events-auto flex items-start gap-3 rounded-2xl border bg-raised/95 px-4 py-3 text-sm shadow-2xl backdrop-blur ${t.kind === "error" ? "border-danger/40" : t.kind === "success" ? "border-gold/40" : "border-line"}`}>
            <p className="flex-1 text-fg/90">{t.text}</p>
            {t.action && <button onClick={() => { t.action!.run(); dismiss(t.id); }} className="shrink-0 cursor-pointer font-medium text-gold hover:text-gold-light">{t.action.label}</button>}
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 cursor-pointer text-dim hover:text-fg"><X className="h-4 w-4" /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function MiniPlayer({ onExpand }: { onExpand: () => void }) {
  const { listening, start, stop, latest, phase, tickRef } = useApp();
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${tickRef.current?.progress ?? 0})`;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [tickRef]);
  return (
    <div data-tauri-drag-region className="relative flex h-full items-center gap-3 overflow-hidden border border-line bg-surface px-3">
      <motion.button whileTap={{ scale: 0.9 }} onClick={() => (listening ? stop() : start("once"))} aria-label={listening ? "Stop" : "Identify song"} className={`grid h-14 w-14 shrink-0 cursor-pointer place-items-center rounded-full border ${listening ? "animate-pulse border-gold/60 bg-gold/15" : "border-gold/25 bg-raised"}`}>
        <BoltGlyph className="h-8 w-8" />
      </motion.button>
      <div data-tauri-drag-region className="min-w-0 flex-1">
        {listening ? (
          <p className="text-sm font-medium text-gold-light">{phase === "matching" ? "Matching…" : phase === "cooldown" ? "Waiting for next song" : "Listening…"}</p>
        ) : latest ? (
          <>
            <p className="truncate text-sm font-semibold">{latest.title}</p>
            <p className="truncate text-xs text-muted">{latest.artist}</p>
          </>
        ) : (
          <p className="text-sm text-muted">Tap the bolt to identify</p>
        )}
      </div>
      {latest && !listening && <Cover song={latest} className="h-12 w-12 shrink-0 rounded-lg" />}
      <button onClick={onExpand} aria-label="Back to full window" className="shrink-0 cursor-pointer rounded-lg p-2 text-muted hover:bg-white/5 hover:text-fg"><Maximize2 className="h-4 w-4" /></button>
      <div ref={bar} className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-gold" />
    </div>
  );
}

function Shell() {
  const [view, setView] = useState<ViewId>("listen");
  const [mini, setMini] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { identifyFile, settings, toast } = useApp();

  // Drop an audio/video file anywhere to identify it
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") setDragging(true);
      else if (e.payload.type === "leave") setDragging(false);
      else if (e.payload.type === "drop") {
        setDragging(false);
        const path = e.payload.paths[0];
        if (path) { setView("listen"); identifyFile(path); }
      }
    });
    return () => { un.then((f) => f()); };
  }, [identifyFile]);

  const updateChecked = useRef(false);
  useEffect(() => {
    if (settings?.autoUpdate && !updateChecked.current) {
      updateChecked.current = true;
      checkForUpdate(toast);
    }
  }, [settings, toast]);

  const setMiniMode = async (on: boolean) => {
    setMini(on);
    await win.setAlwaysOnTop(on);
    await win.setResizable(!on);
    await win.setSize(on ? MINI : FULL);
  };

  if (mini) return <MiniPlayer onExpand={() => setMiniMode(false)} />;

  const current = VIEWS.find((v) => v.id === view)!;
  return (
    <div className="flex h-full flex-col bg-ink">
      <TitleBar onMini={() => setMiniMode(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar view={view} setView={setView} />
        <main className="relative min-w-0 flex-1 overflow-hidden rounded-tl-3xl border-t border-l border-line bg-[radial-gradient(ellipse_at_top,#14120f,#0a0a09_60%)]">
          <AnimatePresence mode="wait">
            <motion.div key={view} className="h-full" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
              {current.el}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <Toasts />
      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-ink/80 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} className="rounded-3xl border-2 border-dashed border-gold/60 px-16 py-12 text-center">
              <BoltGlyph className="mx-auto h-16 w-16" />
              <p className="mt-3 text-lg font-semibold">Drop to identify</p>
              <p className="text-sm text-muted">Audio or video files</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
