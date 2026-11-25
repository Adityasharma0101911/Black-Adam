import { useState } from "react";
import { motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, Radio, Trash2 } from "lucide-react";
import { api, errText } from "../lib/api";
import { clock } from "../lib/format";
import { useApp, type TracklistSession } from "../lib/store";
import { Cover } from "../components/SongHero";

const asText = (s: TracklistSession) =>
  `Tracklist - ${new Date(s.startedAt).toLocaleString()}\n\n` +
  s.entries.map((e, i) => `${String(i + 1).padStart(2, "0")}. [${clock(e.atSec)}] ${e.song.artist} - ${e.song.title}`).join("\n");

export function TracklistView() {
  const { sessions, setSessions, listening, mode, start, stop, toast } = useApp();
  const [sel, setSel] = useState(0);
  const session = sessions[Math.min(sel, sessions.length - 1)];
  const liveNow = listening && mode === "live";

  const exportTxt = async (s: TracklistSession) => {
    const path = await save({ defaultPath: `tracklist-${new Date(s.startedAt).toISOString().slice(0, 10)}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
    if (!path) return;
    try {
      await api.saveText(path, asText(s));
      toast({ kind: "success", text: "Tracklist exported" });
    } catch (e) {
      toast({ kind: "error", text: errText(e) });
    }
  };

  return (
    <div className="flex h-full flex-col px-8 pt-7 pb-6">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Tracklists</h1>
        <button
          onClick={() => (liveNow ? stop() : start("live"))}
          disabled={listening && !liveNow}
          className={`ml-auto flex h-9 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition disabled:opacity-40 ${liveNow ? "bg-gold text-ink" : "border border-line bg-surface hover:border-gold/35"}`}
        >
          <Radio className={`h-4 w-4 ${liveNow ? "animate-pulse" : ""}`} /> {liveNow ? "Recording tracklist… Stop" : "Start a tracklist"}
        </button>
      </header>
      <p className="mt-1 max-w-xl text-sm text-muted">Live mode logs every song in a DJ set, stream or playlist with the time it came on. Export it when you're done.</p>

      {!session ? (
        <p className="m-auto text-muted">No tracklists yet.</p>
      ) : (
        <div className="mt-6 flex min-h-0 flex-1 gap-6">
          <ul className="w-56 shrink-0 space-y-1 overflow-y-auto">
            {sessions.map((s, i) => (
              <li key={s.id}>
                <button onClick={() => setSel(i)} className={`w-full cursor-pointer rounded-xl px-3 py-2 text-left transition ${s.id === session.id ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}>
                  <p className="text-sm font-medium">{new Date(s.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, {new Date(s.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p>
                  <p className="text-xs text-dim">{s.entries.length} songs</p>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col rounded-3xl border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3">
              <span className="text-sm text-muted">{session.entries.length} songs</span>
              <div className="ml-auto flex gap-1">
                <IconBtn label="Copy" onClick={async () => { await navigator.clipboard.writeText(asText(session)); toast({ kind: "success", text: "Tracklist copied" }); }}><Copy className="h-4 w-4" /></IconBtn>
                <IconBtn label="Export" onClick={() => exportTxt(session)}><Download className="h-4 w-4" /></IconBtn>
                <IconBtn label="Delete" onClick={() => { setSessions(sessions.filter((s) => s.id !== session.id)); setSel(0); }}><Trash2 className="h-4 w-4" /></IconBtn>
              </div>
            </div>
            <ol className="flex-1 overflow-y-auto p-3">
              {session.entries.length === 0 && <p className="p-8 text-center text-sm text-muted">Waiting for the first song…</p>}
              {session.entries.map((e, i) => (
                <motion.li key={e.song.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-4 rounded-xl px-2 py-2">
                  <span className="w-14 font-mono text-sm text-gold">{clock(e.atSec)}</span>
                  <Cover song={e.song} className="h-10 w-10 rounded-md" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{e.song.title}</p>
                    <p className="truncate text-sm text-muted">{e.song.artist}</p>
                  </div>
                  <span className="ml-auto font-mono text-xs text-dim">{String(i + 1).padStart(2, "0")}</span>
                </motion.li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-white/5 hover:text-fg" aria-label={label}>
      {children}
      <span>{label}</span>
    </button>
  );
}
