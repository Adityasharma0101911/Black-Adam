import { invoke } from "@tauri-apps/api/core";

export type Song = {
  id: string;
  key: string;
  title: string;
  artist: string;
  album?: string | null;
  genre?: string | null;
  year?: string | null;
  label?: string | null;
  coverUrl?: string | null;
  shazamUrl?: string | null;
  appleMusicUrl?: string | null;
  spotifyUrl?: string | null;
  youtubeUrl?: string | null;
  previewUrl?: string | null;
  offsetSec: number;
  sampleStartMs: number;
  identifiedAt: number;
  source: "system" | "mic" | "file" | "queue" | string;
};

export type Device = { id: string; name: string; kind: "system" | "mic"; isDefault: boolean };

export type Settings = {
  deviceId: string | null;
  hotkey: string;
  notifications: boolean;
  closeToTray: boolean;
  maxListenSecs: number;
  discordEnabled: boolean;
  discordAppId: string;
  overlayEnabled: boolean;
  overlayPort: number;
  spotifyClientId: string;
  spotifyPlaylistId: string | null;
  autoUpdate: boolean;
};

export type Mode = "once" | "live";

export type Tick = {
  phase: "listening" | "matching" | "cooldown";
  mode: Mode;
  level: number;
  bands: number[];
  progress: number;
  cooldownSecs: number;
  device: string;
  kind: "system" | "mic";
};

export type ListenResult = { status: "no-match" | "error" | "queued" | "silent"; message: string };

export type Lyrics = { synced?: string | null; plain?: string | null };

export const api = {
  listDevices: () => invoke<Device[]>("list_devices"),
  startListening: (mode: Mode) => invoke<void>("start_listening", { mode }),
  stopListening: () => invoke<void>("stop_listening"),
  isListening: () => invoke<boolean>("is_listening"),
  identifyFile: (path: string) => invoke<Song | null>("identify_file", { path }),
  getHistory: () => invoke<Song[]>("get_history"),
  deleteSong: (id: string) => invoke<void>("delete_song", { id }),
  clearHistory: () => invoke<void>("clear_history"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  queueCount: () => invoke<number>("queue_count"),
  fetchLyrics: (title: string, artist: string) => invoke<Lyrics>("fetch_lyrics", { title, artist }),
  spotifyStatus: () => invoke<boolean>("spotify_status"),
  spotifyConnect: () => invoke<void>("spotify_connect"),
  spotifyDisconnect: () => invoke<void>("spotify_disconnect"),
  spotifySave: (song: Song) => invoke<string>("spotify_save", { song }),
  spotifyRedirectUri: () => invoke<string>("spotify_redirect_uri"),
  saveText: (path: string, contents: string) => invoke<void>("save_text", { path, contents }),
};

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
