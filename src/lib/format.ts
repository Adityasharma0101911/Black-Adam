import type { Song } from "./api";

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(songs: Song[]) {
  const cols: [string, (s: Song) => unknown][] = [
    ["Identified", (s) => new Date(s.identifiedAt).toISOString()],
    ["Title", (s) => s.title],
    ["Artist", (s) => s.artist],
    ["Album", (s) => s.album],
    ["Year", (s) => s.year],
    ["Genre", (s) => s.genre],
    ["Label", (s) => s.label],
    ["Source", (s) => s.source],
    ["Shazam", (s) => s.shazamUrl],
    ["Apple Music", (s) => s.appleMusicUrl],
  ];
  return [cols.map((c) => c[0]).join(","), ...songs.map((s) => cols.map(([, f]) => csvCell(f(s))).join(","))].join("\n");
}

export const songLine = (s: Song) => `${s.title} by ${s.artist}${s.album ? ` (${s.album}${s.year ? `, ${s.year}` : ""})` : ""}`;

export type LrcLine = { t: number; text: string };

/** Parse LRC "[mm:ss.xx] text" lines, sorted by time. */
export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const line of lrc.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line playing at `pos` seconds (-1 before the first). */
export function activeLine(lines: LrcLine[], pos: number) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
