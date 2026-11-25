import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { api, errText } from "../lib/api";
import { useApp } from "../lib/store";
import { exportCsv } from "./History";
import { checkForUpdate } from "../lib/updater";

const MODS: [keyof KeyboardEvent, string][] = [["ctrlKey", "CommandOrControl"], ["metaKey", "Super"], ["altKey", "Alt"], ["shiftKey", "Shift"]];

/** Turn a keydown into a Tauri accelerator like "CommandOrControl+Shift+B". */
function accelerator(e: React.KeyboardEvent) {
  const mods = MODS.filter(([k]) => e.nativeEvent[k]).map(([, n]) => n);
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key) || mods.length === 0) return null;
  const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code;
  return [...mods, key].join("+");
}

const pretty = (acc: string) => acc.replace("CommandOrControl", navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl").split("+").join(" + ");

export function SettingsView() {
  const { settings, updateSettings, devices, history, setHistory, setLatest, toast } = useApp();
  const [version, setVersion] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [spotifyOn, setSpotifyOn] = useState(false);
  const [redirect, setRedirect] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    getVersion().then(setVersion);
    autostartEnabled().then(setAutostart).catch(() => {});
    api.spotifyStatus().then(setSpotifyOn);
    api.spotifyRedirectUri().then(setRedirect);
  }, []);

  if (!settings) return null;

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (e) { toast({ kind: "error", text: errText(e) }); } finally { setBusy(""); }
  };

  return (
    <div className="h-full overflow-y-auto px-8 pt-7 pb-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 max-w-2xl space-y-4">
        <Group title="Listening">
          <Row label="Audio source" hint="System audio hears what your computer plays. Pick a microphone to identify songs in the room.">
            <select value={settings.deviceId ?? ""} onChange={(e) => updateSettings({ deviceId: e.target.value || null })} className="max-w-[260px] cursor-pointer truncate rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none">
              <option value="">Automatic (system audio)</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.kind === "mic" ? "🎙 " : ""}{d.name}</option>)}
            </select>
          </Row>
          <Row label="Listen for up to" hint="Black Adam tries a match every 3 seconds and stops as soon as it finds one.">
            <div className="flex items-center gap-3">
              <input type="range" min={6} max={20} step={1} value={settings.maxListenSecs} onChange={(e) => updateSettings({ maxListenSecs: Number(e.target.value) })} className="w-36 accent-gold" aria-label="Maximum listening time in seconds" />
              <span className="w-10 font-mono text-sm tabular-nums">{settings.maxListenSecs}s</span>
            </div>
          </Row>
          <Row label="Global hotkey" hint="Identify from anywhere, even when Black Adam is hidden.">
            <button
              onClick={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                if (!recording) return;
                e.preventDefault();
                if (e.key === "Escape") return setRecording(false);
                if (e.key === "Backspace") { updateSettings({ hotkey: "" }); return setRecording(false); }
                const acc = accelerator(e);
                if (acc) { updateSettings({ hotkey: acc }); setRecording(false); }
              }}
              className={`min-w-[180px] cursor-pointer rounded-xl border px-3 py-2 font-mono text-sm ${recording ? "border-gold text-gold-light" : "border-line bg-raised"}`}
            >
              {recording ? "Press keys… (Esc to cancel)" : settings.hotkey ? pretty(settings.hotkey) : "Not set"}
            </button>
          </Row>
        </Group>

        <Group title="App">
          <Toggle label="Notifications" hint="Show the song when Black Adam isn't in front." checked={settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />
          <Toggle label="Keep running in the tray" hint="Closing the window hides it to the tray so the hotkey keeps working." checked={settings.closeToTray} onChange={(v) => updateSettings({ closeToTray: v })} />
          <Toggle
            label="Launch at login"
            hint="Starts quietly in the tray."
            checked={autostart}
            onChange={(v) => run("autostart", async () => { await (v ? enableAutostart() : disableAutostart()); setAutostart(await autostartEnabled()); })}
          />
          <Toggle label="Automatic updates" hint="Check for new versions on launch." checked={settings.autoUpdate} onChange={(v) => updateSettings({ autoUpdate: v })} />
          <Row label={`Version ${version}`}>
            <Btn busy={busy === "update"} onClick={() => run("update", async () => { if (!(await checkForUpdate(toast, true))) toast({ kind: "info", text: "You're on the latest version." }); })}>Check for updates</Btn>
          </Row>
        </Group>

        <Group title="Spotify">
          <p className="text-sm text-muted">
            Save identified songs to a private "Black Adam" playlist. Create an app at{" "}
            <button className="cursor-pointer text-gold underline-offset-2 hover:underline" onClick={() => openUrl("https://developer.spotify.com/dashboard")}>developer.spotify.com</button>, add the redirect URI <code className="selectable rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-fg">{redirect}</code>, and paste its Client ID here.
          </p>
          <Row label="Client ID">
            <TextInput value={settings.spotifyClientId} onCommit={(v) => updateSettings({ spotifyClientId: v })} placeholder="32-character client ID" />
          </Row>
          <Row label={spotifyOn ? "Connected" : "Not connected"}>
            {spotifyOn ? (
              <Btn onClick={() => run("sp", async () => { await api.spotifyDisconnect(); setSpotifyOn(false); })}>Disconnect</Btn>
            ) : (
              <Btn busy={busy === "sp"} disabled={!settings.spotifyClientId} onClick={() => run("sp", async () => { await api.spotifyConnect(); setSpotifyOn(true); toast({ kind: "success", text: "Spotify connected" }); })}>Connect Spotify</Btn>
            )}
          </Row>
        </Group>

        <Group title="Streaming">
          <Toggle label="Discord status" hint={`Shows "Listening to <song>" on your profile. Needs a Discord application ID from discord.com/developers.`} checked={settings.discordEnabled} onChange={(v) => updateSettings({ discordEnabled: v })} />
          {settings.discordEnabled && (
            <Row label="Discord application ID">
              <TextInput value={settings.discordAppId} onCommit={(v) => updateSettings({ discordAppId: v })} placeholder="e.g. 1234567890123456789" />
            </Row>
          )}
          <Toggle label="OBS overlay" hint="A now-playing card you can add to OBS as a Browser Source." checked={settings.overlayEnabled} onChange={(v) => updateSettings({ overlayEnabled: v })} />
          {settings.overlayEnabled && (
            <Row label="Overlay URL">
              <div className="flex items-center gap-2">
                <code className="selectable rounded-lg bg-raised px-2 py-1.5 font-mono text-xs">http://127.0.0.1:{settings.overlayPort}</code>
                <Btn onClick={() => openUrl(`http://127.0.0.1:${settings.overlayPort}`)}>Preview</Btn>
              </div>
            </Row>
          )}
        </Group>

        <Group title="Data">
          <Row label="History" hint={`${history.length} songs saved on this computer.`}>
            <div className="flex gap-2">
              <Btn disabled={!history.length} onClick={() => exportCsv(history, toast)}>Export CSV</Btn>
              <Btn danger disabled={!history.length} onClick={() => run("clear", async () => {
                if (!(await ask(`Delete all ${history.length} songs from your history? This can't be undone.`, { title: "Clear history", kind: "warning" }))) return;
                await api.clearHistory();
                setHistory([]);
                setLatest(null);
              })}>Clear</Btn>
            </div>
          </Row>
        </Group>

        <p className="pt-2 text-center text-xs text-dim">
          Black Adam {version} · GPL-3.0 · by{" "}
          <button className="cursor-pointer hover:text-fg" onClick={() => openUrl("https://github.com/Adityasharma0101911")}>Aditya Sharma</button>
          {" · "}
          <button className="cursor-pointer hover:text-fg" onClick={() => openUrl("https://github.com/Adityasharma0101911/Black-Adam")}>GitHub</button>
          {" · "}
          <button className="cursor-pointer hover:text-fg" onClick={() => openUrl("https://adityasharma0101.vercel.app")}>Portfolio</button>
        </p>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-surface px-5 py-4">
      <h2 className="mb-2 text-xs font-medium tracking-[0.16em] text-gold uppercase">{title}</h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-6 w-11 cursor-pointer rounded-full transition ${checked ? "bg-gold" : "bg-white/15"}`}>
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-5" : ""}`} />
      </button>
    </Row>
  );
}

function TextInput({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value && onCommit(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      placeholder={placeholder}
      spellCheck={false}
      className="w-64 rounded-xl border border-line bg-raised px-3 py-2 font-mono text-sm outline-none placeholder:text-dim focus:border-gold/50"
    />
  );
}

function Btn({ children, onClick, disabled, busy, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`h-9 cursor-pointer rounded-xl border px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "border-danger/30 text-danger hover:bg-danger/10" : "border-line bg-raised hover:border-gold/40"}`}
    >
      {busy ? "Working…" : children}
    </button>
  );
}
