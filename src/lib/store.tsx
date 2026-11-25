import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errText, type Device, type ListenResult, type Mode, type Settings, type Song, type Tick } from "./api";

export type Toast = { id: number; kind: "info" | "error" | "success"; text: string; action?: { label: string; run: () => void } };

export type TracklistEntry = { song: Song; atSec: number };
export type TracklistSession = { id: string; startedAt: number; entries: TracklistEntry[] };

type Status = { text: string; kind: "idle" | "info" | "error" };

type Ctx = {
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  devices: Device[];
  history: Song[];
  setHistory: (h: Song[]) => void;
  latest: Song | null;
  setLatest: (s: Song | null) => void;
  listening: boolean;
  mode: Mode;
  phase: Tick["phase"] | null;
  /** Live tick, read by animation loops without re-rendering */
  tickRef: React.RefObject<Tick | null>;
  status: Status;
  start: (mode: Mode) => void;
  stop: () => void;
  identifyFile: (path: string) => Promise<void>;
  identifying: boolean;
  queue: number;
  sessions: TracklistSession[];
  setSessions: (s: TracklistSession[]) => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
};

const C = createContext<Ctx | null>(null);
export const useApp = () => useContext(C)!;

const SESSIONS_KEY = "black-adam.tracklists";
const loadSessions = (): TracklistSession[] => {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch { return []; }
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [history, setHistory] = useState<Song[]>([]);
  const [latest, setLatest] = useState<Song | null>(null);
  const [listening, setListening] = useState(false);
  const [mode, setMode] = useState<Mode>("once");
  const [phase, setPhase] = useState<Tick["phase"] | null>(null);
  const [status, setStatus] = useState<Status>({ text: "Ready", kind: "idle" });
  const [identifying, setIdentifying] = useState(false);
  const [queue, setQueue] = useState(0);
  const [sessions, setSessionsState] = useState<TracklistSession[]>(loadSessions);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const tickRef = useRef<Tick | null>(null);
  const liveSession = useRef<TracklistSession | null>(null);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.action ? 12000 : 5000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);

  const setSessions = useCallback((s: TracklistSession[]) => {
    setSessionsState(s);
    try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(s.slice(0, 50))); } catch { /* storage unavailable */ }
  }, []);

  // Initial load + device hot-plug polling
  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getHistory().then((h) => { setHistory(h); setLatest(h[0] ?? null); });
    api.queueCount().then(setQueue);
    api.isListening().then(setListening);
    const loadDevices = () => api.listDevices().then(setDevices).catch(() => {});
    loadDevices();
    const t = setInterval(loadDevices, 4000);
    return () => clearInterval(t);
  }, []);

  // Backend events
  useEffect(() => {
    const subs = [
      listen<Tick>("tick", ({ payload }) => {
        tickRef.current = payload;
        // Live mode may be started from the tray, not just the button
        if (payload.mode === "live" && !liveSession.current) {
          liveSession.current = { id: crypto.randomUUID(), startedAt: Date.now(), entries: [] };
        }
        setPhase((p) => (p === payload.phase ? p : payload.phase));
        setMode((m) => (m === payload.mode ? m : payload.mode));
        setListening(true);
      }),
      listen<Song>("song", ({ payload }) => {
        setLatest(payload);
        setHistory((h) => [payload, ...h.filter((s) => s.id !== payload.id)]);
        setStatus({ text: `Found ${payload.title}`, kind: "info" });
        const live = liveSession.current;
        if (live && payload.source !== "file" && payload.source !== "queue") {
          live.entries.push({ song: payload, atSec: (payload.identifiedAt - live.startedAt) / 1000 });
          setSessionsState((all) => {
            const next = [{ ...live }, ...all.filter((s) => s.id !== live.id)];
            try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(next.slice(0, 50))); } catch { /* ignore */ }
            return next;
          });
        }
      }),
      listen<ListenResult>("listen-result", ({ payload }) => {
        setStatus({ text: payload.message, kind: payload.status === "error" ? "error" : "info" });
        if (payload.status !== "no-match") toast({ kind: payload.status === "error" ? "error" : "info", text: payload.message });
      }),
      listen("listen-stopped", () => {
        setListening(false);
        setPhase(null);
        tickRef.current = null;
        liveSession.current = null;
      }),
      listen<number>("queue-updated", ({ payload }) => setQueue(payload)),
    ];
    return () => { subs.forEach((p) => p.then((un) => un())); };
  }, [toast]);

  const start = useCallback((m: Mode) => {
    setMode(m);
    setListening(true);
    setPhase("listening");
    setStatus({ text: m === "live" ? "Live mode: logging every song" : "Listening…", kind: "info" });
    liveSession.current = m === "live" ? { id: crypto.randomUUID(), startedAt: Date.now(), entries: [] } : null;
    api.startListening(m).catch((e) => toast({ kind: "error", text: errText(e) }));
  }, [toast]);

  const stop = useCallback(() => {
    api.stopListening();
    setStatus({ text: "Stopped", kind: "idle" });
  }, []);

  const identifyFile = useCallback(async (path: string) => {
    setIdentifying(true);
    setStatus({ text: `Identifying ${path.split(/[\\/]/).pop()}…`, kind: "info" });
    try {
      const song = await api.identifyFile(path);
      if (!song) {
        setStatus({ text: "No match in that file", kind: "info" });
        toast({ kind: "info", text: "Couldn't find a match in that file." });
      }
    } catch (e) {
      setStatus({ text: errText(e), kind: "error" });
      toast({ kind: "error", text: errText(e) });
    } finally {
      setIdentifying(false);
    }
  }, [toast]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      setSettings(await api.saveSettings(next));
    } catch (e) {
      setSettings(settings);
      toast({ kind: "error", text: errText(e) });
    }
  }, [settings, toast]);

  const value = useMemo<Ctx>(() => ({
    settings, updateSettings, devices, history, setHistory, latest, setLatest, listening, mode, phase, tickRef,
    status, start, stop, identifyFile, identifying, queue, sessions, setSessions, toasts, toast, dismiss,
  }), [settings, updateSettings, devices, history, latest, listening, mode, phase, status, start, stop, identifyFile, identifying, queue, sessions, setSessions, toasts, toast, dismiss]);

  return <C.Provider value={value}>{children}</C.Provider>;
}
