import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, ListMusic, Mic2, Pause, Play, Plus } from "lucide-react";
import { api, errText, type Lyrics, type Song } from "../lib/api";
import { activeLine, parseLrc, songLine, timeAgo } from "../lib/format";
import { useApp } from "../lib/store";

export function Cover({ song, className = "" }: { song: Song; className?: string }) {
  const [failed, setFailed] = useState(false);
  return song.coverUrl && !failed ? (
    <img src={song.coverUrl} alt={`${song.album ?? song.title} cover`} onError={() => setFailed(true)} className={`object-cover ${className}`} draggable={false} />
  ) : (
    <div className={`grid place-items-center bg-gradient-to-br from-raised to-ink text-gold/60 ${className}`} aria-label="No cover art">
      <ListMusic className="h-1/3 w-1/3" />
    </div>
  );
}

const LINKS: { key: keyof Song; label: string }[] = [
  { key: "spotifyUrl", label: "Spotify" },
  { key: "appleMusicUrl", label: "Apple Music" },
  { key: "youtubeUrl", label: "YouTube" },
];

function Preview({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [p, setP] = useState(0);
  useEffect(() => () => audio.current?.pause(), [url]);
  return (
    <button
      onClick={() => (playing ? audio.current?.pause() : audio.current?.play())}
      className="group relative grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-gold text-ink transition hover:bg-gold-light"
      aria-label={playing ? "Pause preview" : "Play 30-second preview"}
      title="30-second preview"
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r="20.5" fill="none" stroke="rgba(0,0,0,0.2)" strokeWidth="3" />
        <circle cx="22" cy="22" r="20.5" fill="none" stroke="#070707" strokeWidth="3" strokeDasharray={128.8} strokeDashoffset={128.8 * (1 - p)} />
      </svg>
      {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
      <audio
        ref={audio}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setP(0); }}
        onTimeUpdate={(e) => setP(e.currentTarget.currentTime / (e.currentTarget.duration || 30))}
      />
    </button>
  );
}

function LyricsPanel({ song }: { song: Song }) {
  const [lyrics, setLyrics] = useState<Lyrics | null | "loading">("loading");
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLyrics("loading");
    api.fetchLyrics(song.title, song.artist).then((l) => alive && setLyrics(l)).catch(() => alive && setLyrics(null));
    return () => { alive = false; };
  }, [song.id, song.title, song.artist]);

  const lines = lyrics && lyrics !== "loading" && lyrics.synced ? parseLrc(lyrics.synced) : [];
  // Only live captures know where in the song we are
  const synced = lines.length > 0 && song.sampleStartMs > 0;
  const pos = song.offsetSec + (now - song.sampleStartMs) / 1000;
  const idx = synced ? activeLine(lines, pos) : -1;

  useEffect(() => {
    if (!synced) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [synced]);

  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [idx]);

  if (lyrics === "loading") return <p className="py-6 text-sm text-muted">Finding lyrics…</p>;
  if (!lyrics || (!lyrics.synced && !lyrics.plain)) return <p className="py-6 text-sm text-muted">No lyrics found for this song.</p>;

  return (
    <div ref={box} className="selectable relative max-h-64 overflow-y-auto py-2 pr-2 [mask-image:linear-gradient(transparent,black_15%,black_85%,transparent)]">
      {lines.length > 0
        ? lines.map((l, i) => (
            <p
              key={i}
              data-line={i}
              className={`origin-left py-1 text-[17px] leading-snug font-medium transition-all duration-500 ${
                !synced ? "text-fg/80" : i === idx ? "scale-[1.02] text-gold-light" : i < idx ? "text-fg/30" : "text-fg/55"
              }`}
            >
              {l.text || "♪"}
            </p>
          ))
        : lyrics.plain!.split("\n").map((l, i) => <p key={i} className="py-0.5 text-[15px] text-fg/80">{l || " "}</p>)}
    </div>
  );
}

export function SongHero({ song }: { song: Song }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(`${songLine(song)}${song.shazamUrl ? `\n${song.shazamUrl}` : ""}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const saveSpotify = async () => {
    setSaving(true);
    try {
      const name = await api.spotifySave(song);
      toast({ kind: "success", text: `Added "${name}" to your Black Adam playlist` });
    } catch (e) {
      toast({ kind: "error", text: errText(e) });
    } finally {
      setSaving(false);
    }
  };

  const meta = [song.album, song.year, song.genre, song.label].filter(Boolean);

  return (
    <motion.article
      key={song.id}
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 24 }}
      className="relative w-full overflow-hidden rounded-3xl border border-line bg-surface"
    >
      {song.coverUrl && (
        <img src={song.coverUrl} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-3xl saturate-150" />
      )}
      <div className="relative flex gap-5 p-5">
        <motion.div initial={{ rotate: -4, scale: 0.9 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: "spring", stiffness: 180, damping: 14, delay: 0.05 }}>
          <Cover song={song} className="h-32 w-32 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.6)]" />
        </motion.div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="text-[11px] font-medium tracking-[0.16em] text-gold uppercase">{timeAgo(song.identifiedAt)} · {song.source === "file" ? "from file" : song.source === "mic" ? "microphone" : song.source === "queue" ? "identified later" : "system audio"}</span>
          <h2 className="selectable mt-1 line-clamp-2 text-[28px] leading-tight font-semibold tracking-tight" title={song.title}>{song.title}</h2>
          <p className="selectable truncate text-lg text-fg/75">{song.artist}</p>
          {meta.length > 0 && <p className="selectable mt-1 line-clamp-2 text-sm text-muted">{meta.join(" · ")}</p>}
        </div>
      </div>
      <div className="relative flex flex-wrap items-center gap-2 px-5 pb-4">
        {song.previewUrl && <Preview url={song.previewUrl} />}
        {LINKS.filter((l) => song[l.key]).map((l) => (
          <button key={l.key} onClick={() => openUrl(song[l.key] as string)} className="h-9 cursor-pointer rounded-full border border-line bg-white/5 px-3.5 text-[13px] font-medium whitespace-nowrap text-fg/85 transition hover:border-gold/40 hover:text-fg">
            {l.label}
          </button>
        ))}
      </div>
      <div className="relative flex items-center gap-0.5 border-t border-line px-2 py-2">
        <IconAction onClick={() => setShowLyrics((v) => !v)} active={showLyrics} icon={<Mic2 className="h-4 w-4" />} label="Lyrics" />
        <IconAction onClick={copy} icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} label={copied ? "Copied" : "Copy"} />
        <IconAction onClick={saveSpotify} disabled={saving} icon={<Plus className="h-4 w-4" />} label={saving ? "Saving…" : "Save to Spotify"} />
        {song.shazamUrl && <IconAction onClick={() => openUrl(song.shazamUrl!)} icon={<ExternalLink className="h-4 w-4" />} label="Shazam" />}
      </div>
      <AnimatePresence initial={false}>
        {showLyrics && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="relative overflow-hidden px-5">
            <LyricsPanel song={song} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function IconAction({ icon, label, onClick, active, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium whitespace-nowrap transition disabled:opacity-50 ${active ? "bg-gold/15 text-gold-light" : "text-muted hover:bg-white/5 hover:text-fg"}`}
    >
      {icon}
      {label}
    </button>
  );
}
