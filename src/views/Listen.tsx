import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileAudio, Radio, Square } from "lucide-react";
import { ListenButton } from "../components/Bolt";
import { SongHero } from "../components/SongHero";
import { useApp } from "../lib/store";

export function ListenView() {
  const { listening, mode, phase, status, start, stop, latest, devices, settings, updateSettings, identifyFile, identifying, tickRef } = useApp();
  const device = devices.find((d) => d.id === settings?.deviceId) ?? devices[0];

  const pickFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Audio or video", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "mp4", "mkv", "webm", "mov"] }] });
    if (typeof path === "string") identifyFile(path);
  };

  const headline = !listening
    ? identifying ? "Reading the file…" : "Tap the bolt to identify"
    : phase === "matching" ? "Matching…"
    : phase === "cooldown" ? "Waiting for the next song"
    : mode === "live" ? "Live: listening for song changes" : "Listening…";

  return (
    <div className="flex h-full gap-6 overflow-x-hidden overflow-y-auto px-8 py-8">
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center">
        <ListenButton size={330} />
        <AnimatePresence mode="wait">
          <motion.h1 key={headline} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-4 text-xl font-semibold tracking-tight">
            {headline}
          </motion.h1>
        </AnimatePresence>
        <p className={`mt-1 max-w-sm text-center text-sm ${status.kind === "error" ? "text-danger" : "text-muted"}`} role="status">
          {listening ? `From ${tickRef.current?.device ?? device?.name ?? "default output"}` : status.text}
        </p>

        <div className="mt-6 flex items-center gap-2">
          {listening && mode === "live" ? (
            <Pill onClick={stop} icon={<Square className="h-3.5 w-3.5 fill-current" />} label="Stop live mode" active />
          ) : (
            <Pill onClick={() => start("live")} icon={<Radio className="h-4 w-4" />} label="Live mode" disabled={listening} />
          )}
          <Pill onClick={pickFile} icon={<FileAudio className="h-4 w-4" />} label="Identify a file" disabled={identifying} />
        </div>

        {devices.length > 0 && settings && (
          <label className="mt-5 flex items-center gap-2 text-sm text-muted">
            <span className="sr-only">Audio source</span>
            <select
              value={settings.deviceId ?? ""}
              onChange={(e) => updateSettings({ deviceId: e.target.value || null })}
              className="max-w-[300px] cursor-pointer truncate rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg/85 outline-none hover:border-gold/30"
            >
              <option value="">Automatic (system audio)</option>
              <optgroup label="What your computer plays">
                {devices.filter((d) => d.kind === "system").map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? " (default)" : ""}</option>)}
              </optgroup>
              <optgroup label="Microphones">
                {devices.filter((d) => d.kind === "mic").map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? " (default)" : ""}</option>)}
              </optgroup>
            </select>
          </label>
        )}
      </section>

      <section className="flex w-[400px] shrink-0 flex-col justify-center">
        <AnimatePresence mode="wait">
          {latest ? (
            <SongHero key={latest.id} song={latest} />
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-3xl border border-dashed border-line p-8 text-center">
              <p className="text-lg font-medium">Nothing identified yet</p>
              <p className="mt-2 text-sm text-muted">Play a song anywhere on your computer and hit the bolt, press {settings?.hotkey.replace("CommandOrControl", "Ctrl") ?? "the hotkey"}, or drop an audio file here.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

function Pill({ icon, label, onClick, disabled, active }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "border-gold/50 bg-gold/15 text-gold-light" : "border-line bg-surface text-fg/85 hover:border-gold/35"
      }`}
    >
      {icon}
      {label}
    </motion.button>
  );
}
