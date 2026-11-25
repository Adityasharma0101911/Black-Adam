import { useMemo } from "react";
import { motion } from "motion/react";
import { useApp } from "../lib/store";
import type { Song } from "../lib/api";

function topBy(songs: Song[], key: (s: Song) => string | null | undefined, n = 6) {
  const m = new Map<string, number>();
  for (const s of songs) {
    const k = key(s);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function StatsView() {
  const { history } = useApp();

  const stats = useMemo(() => {
    const day = 86_400_000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => {
      const start = today.getTime() - (13 - i) * day;
      return { start, count: history.filter((s) => s.identifiedAt >= start && s.identifiedAt < start + day).length };
    });
    const week = history.filter((s) => s.identifiedAt >= today.getTime() - 6 * day).length;
    return {
      total: history.length,
      artists: new Set(history.map((s) => s.artist)).size,
      week,
      days,
      topArtists: topBy(history, (s) => s.artist),
      topGenres: topBy(history, (s) => s.genre),
      topSongs: topBy(history, (s) => `${s.title} — ${s.artist}`, 5),
    };
  }, [history]);

  const maxDay = Math.max(1, ...stats.days.map((d) => d.count));

  return (
    <div className="h-full overflow-y-auto px-8 pt-7 pb-8">
      <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
      {stats.total === 0 ? (
        <p className="mt-16 text-center text-muted">Identify a few songs to see your stats.</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-3 gap-4">
            <Figure label="Songs identified" value={stats.total} />
            <Figure label="Different artists" value={stats.artists} />
            <Figure label="This week" value={stats.week} />
          </div>

          <section className="mt-4 rounded-3xl border border-line bg-surface p-5">
            <h2 className="text-sm font-medium text-muted">Last 14 days</h2>
            <div className="mt-4 flex h-36 items-end gap-2" role="img" aria-label={`Songs per day over the last 14 days: ${stats.days.map((d) => d.count).join(", ")}`}>
              {stats.days.map((d, i) => (
                <div key={d.start} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                  <span className="font-mono text-[11px] text-dim opacity-0 transition group-hover:opacity-100">{d.count}</span>
                  <motion.div
                    className="w-full origin-bottom rounded-md bg-gradient-to-t from-gold-deep to-gold"
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ delay: i * 0.03, type: "spring", stiffness: 160, damping: 20 }}
                    style={{ height: d.count ? `${(d.count / maxDay) * 85}%` : 2, opacity: d.count ? 1 : 0.2 }}
                  />
                  <span className="text-[10px] text-dim">{new Date(d.start).toLocaleDateString(undefined, { weekday: "narrow" })}</span>
                </div>
              ))}
            </div>
          </section>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Ranking title="Top artists" rows={stats.topArtists} />
            <Ranking title="Top genres" rows={stats.topGenres} />
          </div>
          <div className="mt-4"><Ranking title="Most identified songs" rows={stats.topSongs} /></div>
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-3xl border border-line bg-surface p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-mono text-4xl font-semibold tracking-tight text-gold-light tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

function Ranking({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <section className="rounded-3xl border border-line bg-surface p-5">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {rows.length === 0 ? <p className="mt-3 text-sm text-dim">Not enough data yet.</p> : (
        <ol className="mt-3 space-y-2.5">
          {rows.map(([name, n], i) => (
            <li key={name} className="relative">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate"><span className="mr-2 font-mono text-dim">{i + 1}</span>{name}</span>
                <span className="font-mono text-dim tabular-nums">{n}</span>
              </div>
              <motion.div className="mt-1 h-1 origin-left rounded-full bg-gold/70" style={{ width: `${(n / max) * 100}%` }} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: i * 0.05, duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
