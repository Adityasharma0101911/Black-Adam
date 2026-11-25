import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Search, Trash2, X } from "lucide-react";
import { api, errText, type Song } from "../lib/api";
import { timeAgo, toCsv } from "../lib/format";
import { useApp } from "../lib/store";
import { Cover, SongHero } from "../components/SongHero";

export async function exportCsv(songs: Song[], toast: ReturnType<typeof useApp>["toast"]) {
  const path = await save({ defaultPath: "black-adam-history.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  try {
    await api.saveText(path, toCsv(songs));
    toast({ kind: "success", text: `Exported ${songs.length} songs` });
  } catch (e) {
    toast({ kind: "error", text: errText(e) });
  }
}

export function HistoryView() {
  const { history, setHistory, toast, setLatest, latest } = useApp();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Song | null>(null);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? history.filter((s) => [s.title, s.artist, s.album, s.genre].some((v) => v?.toLowerCase().includes(t))) : history;
  }, [history, q]);

  const remove = async (s: Song) => {
    await api.deleteSong(s.id);
    setHistory(history.filter((x) => x.id !== s.id));
    if (latest?.id === s.id) setLatest(history.find((x) => x.id !== s.id) ?? null);
    if (open?.id === s.id) setOpen(null);
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`flex items-center gap-3 ${open ? "px-5" : "px-8"} pt-7 pb-4`}>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <span className="font-mono text-sm text-dim">{history.length}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 focus-within:border-gold/40">
              <Search className="h-4 w-4 text-dim" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={open ? "Search" : "Search songs, artists, albums"} className={`${open ? "w-24" : "w-56"} bg-transparent text-sm outline-none placeholder:text-dim`} aria-label="Search history" />
            </label>
            <button onClick={() => exportCsv(shown, toast)} disabled={!shown.length} className="flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm text-fg/85 hover:border-gold/35 disabled:opacity-40">
              <Download className="h-4 w-4" /> {open ? "CSV" : "Export CSV"}
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {shown.length === 0 ? (
            <p className="px-3 py-16 text-center text-muted">{history.length ? "No songs match your search." : "Songs you identify show up here, saved on this computer."}</p>
          ) : (
            <ul>
              {shown.map((s, i) => (
                <motion.li
                  key={s.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 12) * 0.025 }}
                  className={`group flex cursor-pointer items-center gap-4 rounded-2xl px-3 py-2.5 transition ${open?.id === s.id ? "bg-white/[0.06]" : "hover:bg-white/[0.04]"}`}
                  onClick={() => setOpen(s)}
                >
                  <Cover song={s} className="h-12 w-12 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.title}</p>
                    <p className="truncate text-sm text-muted">{s.artist}{s.album ? ` · ${s.album}` : ""}</p>
                  </div>
                  {!open && <span className="text-sm text-dim">{s.genre}</span>}
                  <span className={`${open ? "w-16 text-xs" : "w-24 text-sm"} text-right text-dim`}>{timeAgo(s.identifiedAt)}</span>
                  <button onClick={(e) => { e.stopPropagation(); remove(s); }} className="cursor-pointer rounded-lg p-2 text-dim opacity-0 transition group-hover:opacity-100 hover:bg-white/5 hover:text-danger focus:opacity-100" aria-label={`Delete ${s.title}`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.aside initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 28 }} className="relative w-[432px] shrink-0 overflow-y-auto border-l border-line p-4">
            <button onClick={() => setOpen(null)} className="absolute top-3 right-3 z-10 cursor-pointer rounded-lg p-1.5 text-muted hover:bg-white/5 hover:text-fg" aria-label="Close details">
              <X className="h-4 w-4" />
            </button>
            <div className="pt-6"><SongHero song={open} /></div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
