//! JSON files in the app data folder: settings, history, offline queue, Spotify tokens.

use crate::shazam::Song;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub device_id: Option<String>,
    pub hotkey: String,
    pub notifications: bool,
    pub close_to_tray: bool,
    /// Longest a single recognition attempt listens (seconds)
    pub max_listen_secs: u32,
    pub discord_enabled: bool,
    pub discord_app_id: String,
    pub overlay_enabled: bool,
    pub overlay_port: u16,
    pub spotify_client_id: String,
    pub spotify_playlist_id: Option<String>,
    pub auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device_id: None,
            hotkey: "CommandOrControl+Shift+B".into(),
            notifications: true,
            close_to_tray: true,
            max_listen_secs: 12,
            discord_enabled: false,
            discord_app_id: String::new(),
            overlay_enabled: false,
            overlay_port: 7777,
            spotify_client_id: String::new(),
            spotify_playlist_id: None,
            auto_update: true,
        }
    }
}

/// A recording that couldn't be sent while offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSignature {
    pub uri: String,
    pub sample_ms: u32,
    pub captured_at: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
}

pub const MAX_HISTORY: usize = 5000;

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        std::fs::create_dir_all(&dir).ok();
        Self { dir }
    }

    pub fn load<T: DeserializeOwned + Default>(&self, name: &str) -> T {
        std::fs::read(self.dir.join(name))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Write via a temp file so a crash mid-write can't corrupt the history.
    pub fn save<T: Serialize>(&self, name: &str, value: &T) {
        let tmp = self.dir.join(format!("{name}.tmp"));
        if let Ok(json) = serde_json::to_vec_pretty(value) {
            if std::fs::write(&tmp, json).is_ok() {
                std::fs::rename(&tmp, self.dir.join(name)).ok();
            }
        }
    }
}

/// Newest first; drops the oldest beyond MAX_HISTORY.
pub fn push_history(history: &mut Vec<Song>, song: Song) {
    history.insert(0, song);
    history.truncate(MAX_HISTORY);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_and_tolerates_missing_or_partial_files() {
        let dir = std::env::temp_dir().join(format!("black-adam-test-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone());
        assert_eq!(store.load::<Settings>("settings.json"), Settings::default());
        std::fs::write(dir.join("settings.json"), r#"{"overlayPort": 9000}"#).unwrap();
        let s: Settings = store.load("settings.json");
        assert_eq!((s.overlay_port, s.max_listen_secs), (9000, 12));
        let mut h = vec![];
        push_history(&mut h, Song { title: "a".into(), ..Default::default() });
        push_history(&mut h, Song { title: "b".into(), ..Default::default() });
        store.save("history.json", &h);
        let back: Vec<Song> = store.load("history.json");
        assert_eq!(back[0].title, "b");
        std::fs::remove_dir_all(dir).ok();
    }
}
